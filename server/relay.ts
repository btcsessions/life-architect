// The relay: how Hermes (and through it Claude, ChatGPT or Telegram) adds to the deck and asks what's next.
// Every call needs the relay token. People is never readable or writable through here.
import type { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./app.ts";
import type { Area, Task } from "./db.ts";
import { rank } from "./rank.ts";

export function mountRelay(app: Hono, ctx: Ctx) {
  const { db } = ctx;

  const authorised = (header: string | undefined): boolean => {
    const token = ctx.secret.get("relay_token");
    const given = header?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token || given.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };

  // Shown once, when created. Creating a new one replaces the old.
  app.post("/api/settings/relay-token", (c) => {
    const token = randomBytes(24).toString("hex");
    ctx.secret.set("relay_token", token);
    return c.json({ token });
  });
  app.get("/api/settings/relay-token", (c) => c.json({ set: Boolean(ctx.secret.get("relay_token")) }));

  app.use("/api/relay/*", async (c, next) => {
    if (!ctx.secret.get("relay_token")) return c.json({ error: "The relay isn't switched on. Create a token in Settings first." }, 503);
    if (!authorised(c.req.header("authorization"))) return c.json({ error: "Wrong or missing relay token." }, 401);
    await next();
  });

  // Add something said elsewhere. Body: {"text": "...", "source": "claude" | "chatgpt" | "telegram" | ...}
  app.post("/api/relay/add", async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "Send the words to add as \"text\"." }, 400);
    if (text.length > 8000) return c.json({ error: "Too long for one add (8,000 characters max)." }, 400);
    const source = typeof body?.source === "string" && body.source.trim() ? body.source.trim().slice(0, 40).toLowerCase() : "hermes";
    const { created } = await ctx.capture(text, source === "app" ? "hermes" : source);
    return c.json({
      added: created.map((t) => ({ title: t.title, area: t.area_name, due: t.due, time: t.due_time, handed_to: t.delegate })),
    });
  });

  // What's next, for reading aloud. People appears only as a count.
  app.get("/api/relay/next", (c) => {
    const d = ctx.day();
    const areas = db.prepare("SELECT * FROM areas ORDER BY sort").all() as Area[];
    const sealed = new Set(areas.filter((a) => a.locked).map((a) => a.id));
    const names = Object.fromEntries(areas.map((a) => [a.id, a.name]));
    const ranked = rank(db.prepare("SELECT * FROM tasks WHERE status = 'open'").all() as Task[], d);
    const open = ranked.filter((r) => !sealed.has(r.task.area_id));
    return c.json({
      today: d,
      next: open.slice(0, 5).map((r) => ({ title: r.task.title, area: names[r.task.area_id], why: r.why })),
      needs_you: Object.fromEntries(
        areas.map((a) => [a.name, ranked.filter((r) => r.task.area_id === a.id).length]).filter(([, n]) => (n as number) > 0),
      ),
    });
  });

  // For the deck's own "added from other apps" list (no token: same trust as the rest of the app).
  app.get("/api/added", (c) => {
    const rows = db
      .prepare("SELECT text, source, created_at FROM captures WHERE created_at >= ? AND source != 'app' ORDER BY id DESC LIMIT 50")
      .all(ctx.day());
    return c.json({ items: rows });
  });
}
