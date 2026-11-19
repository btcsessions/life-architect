// A PIN gate for one module. The PIN is never stored: only a salted scrypt hash.
// An unlock lasts until it has been idle for a while, the module is locked by hand, or the app restarts.
import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./app.ts";

export interface Lock { isOpen: (c: any) => boolean }

export function mountLock(app: Hono, ctx: Ctx, name: "money" | "people", idleMs = 15 * 60_000): Lock {
  const cookie = `la_${name}`;
  const sessions = new Map<string, number>(); // token -> last seen
  let fails = 0;
  let blockedUntil = 0;

  const hashPin = (pin: string, salt: string) => scryptSync(pin, Buffer.from(salt, "hex"), 32).toString("hex");
  const stored = () => ctx.secret.get(`${name}_pin`); // "salt:hash"
  const check = (pin: string): boolean => {
    const s = stored();
    if (!s) return false;
    const [salt, hash] = s.split(":");
    const got = Buffer.from(hashPin(pin, salt), "hex");
    return timingSafeEqual(got, Buffer.from(hash, "hex"));
  };
  const validPin = (p: unknown): p is string => typeof p === "string" && /^\d{4,12}$/.test(p);

  const isOpen = (c: any): boolean => {
    const token = getCookie(c, cookie);
    const seen = token ? sessions.get(token) : undefined;
    const t = ctx.now().getTime();
    if (!token || seen === undefined) return false;
    if (t - seen > idleMs) {
      sessions.delete(token);
      return false;
    }
    sessions.set(token, t);
    return true;
  };
  const open = (c: any) => {
    const token = randomBytes(24).toString("hex");
    sessions.set(token, ctx.now().getTime());
    setCookie(c, cookie, token, { httpOnly: true, sameSite: "Strict", path: "/" });
  };

  app.get(`/api/${name}/status`, (c) => c.json({ set: Boolean(stored()), open: isOpen(c), idle_minutes: Math.round(idleMs / 60_000) }));

  // Set the PIN the first time, or change it (which needs the current one).
  app.post(`/api/${name}/pin`, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!validPin(b.pin)) return c.json({ error: "A PIN is 4 to 12 digits." }, 400);
    if (stored() && !(typeof b.current === "string" && check(b.current))) return c.json({ error: "The current PIN is wrong." }, 403);
    const salt = randomBytes(16).toString("hex");
    ctx.secret.set(`${name}_pin`, `${salt}:${hashPin(b.pin, salt)}`);
    sessions.clear();
    open(c);
    return c.json({ ok: true });
  });

  app.post(`/api/${name}/unlock`, async (c) => {
    const t = ctx.now().getTime();
    if (t < blockedUntil) return c.json({ error: `Too many wrong tries. Wait ${Math.ceil((blockedUntil - t) / 1000)} seconds.` }, 429);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.pin === "string" && check(b.pin)) {
      fails = 0;
      open(c);
      return c.json({ ok: true });
    }
    fails++;
    // 5 wrong tries: 30 seconds. Each one after that doubles it, up to an hour.
    if (fails >= 5) blockedUntil = t + Math.min(30_000 * 2 ** (fails - 5), 3_600_000);
    return c.json({ error: "Wrong PIN." }, 403);
  });

  app.post(`/api/${name}/lock`, (c) => {
    const token = getCookie(c, cookie);
    if (token) sessions.delete(token);
    deleteCookie(c, cookie, { path: "/" });
    return c.json({ ok: true });
  });

  // Everything else under /api/<name>/ needs the module open.
  app.use(`/api/${name}/*`, async (c, next) => {
    if (/\/(status|pin|unlock|lock)$/.test(c.req.path)) return next();
    if (!isOpen(c)) return c.json({ error: "Locked.", locked: true }, 423);
    await next();
  });

  return { isOpen };
}
