// Noticed: light pattern-spotting over what's already on the Umbrel, shown under Build & Automate.
// It only suggests. Saying yes adds a task to Build; nothing is automated behind your back.
import type { Hono } from "hono";
import type { Ctx } from "./app.ts";

export interface Suggestion { key: string; text: string; task: string }
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export function findPatterns(ctx: Ctx): Suggestion[] {
  const { db } = ctx;
  const out: Suggestion[] = [];
  const since = new Date(ctx.now().getTime() - 90 * 86_400_000).toISOString();
  const tasks = db.prepare("SELECT t.*, a.name AS area_name, a.locked FROM tasks t JOIN areas a ON a.id = t.area_id WHERE t.created_at >= ? AND a.locked = 0").all(since) as any[];

  // The same thing typed in again and again.
  const titles = new Map<string, any[]>();
  for (const t of tasks) if (t.source !== "travel" && t.source !== "inbox") { const k = norm(t.title); if (k.length > 3) titles.set(k, [...(titles.get(k) ?? []), t]); }
  for (const [k, list] of titles) if (list.length >= 3) out.push({ key: `repeat:${k}`, text: `You've added "${list[0].title}" ${list.length} times. It could add itself on a schedule.`, task: `Make "${list[0].title}" repeat on its own` });

  // The same person keeps getting the same area's work.
  const handed = new Map<string, any[]>();
  for (const t of tasks) if (t.delegate && t.source !== "inbox") { const k = `${t.area_id}|${t.delegate.toLowerCase()}`; handed.set(k, [...(handed.get(k) ?? []), t]); }
  for (const [k, list] of handed) if (list.length >= 3) out.push({ key: `handoff:${k}`, text: `${list.length} ${list[0].area_name} items went to ${list[0].delegate}. New ones like these could go to them by default.`, task: `Send ${list[0].area_name} items like "${list[0].title}" to ${list[0].delegate} by default` });

  // Things that have sat overdue for weeks.
  const cutoff = new Date(ctx.now().getTime() - 21 * 86_400_000).toISOString().slice(0, 10);
  for (const t of tasks) if (t.status === "open" && !t.delegate && t.due && t.due < cutoff) out.push({ key: `stale:${t.id}`, text: `"${t.title}" has been overdue since ${t.due}. Drop it, hand it off, or give it a real date.`, task: `Decide what to do about "${t.title}"` });

  // Email habits.
  const table = (n: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  if (table("mail_rules")) {
    if (ctx.setting("mail_auto_delegate") !== "on") {
      for (const r of db.prepare("SELECT * FROM mail_rules WHERE uses >= 3").all() as any[]) out.push({ key: `mailrule:${r.sender}`, text: `Email from ${r.sender} has gone to ${r.name} ${r.uses} times. Automatic hand-off (in Settings) would send these without a tap.`, task: `Turn on automatic email hand-off for ${r.sender} to ${r.name}` });
    }
    for (const r of db.prepare("SELECT from_addr, from_name, COUNT(*) AS n FROM mail WHERE handled_how = 'Cleared' GROUP BY from_addr HAVING n >= 4").all() as any[]) out.push({ key: `mailclear:${r.from_addr}`, text: `You've cleared ${r.n} emails from ${r.from_name} without acting. Unsubscribe, or have them skipped.`, task: `Unsubscribe from or filter ${r.from_name} <${r.from_addr}>` });
  }
  return out;
}

export function mountNoticed(app: Hono, ctx: Ctx) {
  const { db } = ctx;
  db.exec("CREATE TABLE IF NOT EXISTS noticed_seen (key TEXT PRIMARY KEY, answer TEXT NOT NULL, ts TEXT NOT NULL)");
  const open = () => { const seen = new Set((db.prepare("SELECT key FROM noticed_seen").all() as any[]).map((r) => r.key)); return findPatterns(ctx).filter((s) => !seen.has(s.key)).slice(0, 6); };
  app.get("/api/noticed", (c) => c.json({ suggestions: open().map(({ key, text }) => ({ key, text })) }));
  app.post("/api/noticed", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    const s = open().find((x) => x.key === b.key);
    if (!s) return c.json({ error: "That suggestion is gone." }, 404);
    const yes = b.answer === "yes";
    if (yes) db.prepare("INSERT INTO tasks (area_id, title, importance, source, created_at) VALUES ('build', ?, 2, 'noticed', ?)").run(s.task.slice(0, 200), ctx.now().toISOString());
    db.prepare("INSERT OR REPLACE INTO noticed_seen (key, answer, ts) VALUES (?, ?, ?)").run(s.key, yes ? "yes" : "no", ctx.now().toISOString());
    return c.json({ ok: true, added: yes });
  });
}
