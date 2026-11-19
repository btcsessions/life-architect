// Asks: things typed or said that are for the assistant to DO, not tasks for the owner.
// They go to the deck model (Hermes) in the background; the answer shows on the deck.
import type { Hono } from "hono";
import type { Ctx } from "./app.ts";
import { chat } from "./file.ts";

const RULES = `You are the owner's assistant. They put this into their Life Architect deck as something for YOU to do, not a task for them.
Do it now with whatever tools and memory you have. Do not add it to their task list.
Reply in at most three short sentences: what you did, or exactly what you still need from them. If you can't do it, say so plainly.`;

export function mountAsks(app: Hono, ctx: Ctx) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS asks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, context TEXT, context_label TEXT, source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'working', reply TEXT, created_at TEXT NOT NULL, done_at TEXT, cleared INTEGER NOT NULL DEFAULT 0
  )`);
  // Anything still "working" was cut off by a restart.
  db.prepare("UPDATE asks SET status = 'failed', reply = 'This was interrupted by a restart. Ask again.' WHERE status = 'working'").run();
  const now = () => ctx.now().toISOString();
  const get = (id: number) => db.prepare("SELECT id, text, context_label, source, status, reply, created_at FROM asks WHERE id = ?").get(id) as any;
  const open = () => db.prepare("SELECT id, text, context_label, source, status, reply, created_at FROM asks WHERE cleared = 0 ORDER BY id DESC LIMIT 12").all();

  /** Hand something to the assistant. Returns at once; the work happens in the background. */
  function start(text: string, source: string, context?: { label: string; body: string }) {
    const cfg = ctx.modelFor("llm");
    const id = Number(db.prepare("INSERT INTO asks (text, context, context_label, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(text.slice(0, 4000), context?.body.slice(0, 12_000) ?? null, context?.label.slice(0, 200) ?? null, source, now()).lastInsertRowid);
    const finish = (status: string, reply: string) => db.prepare("UPDATE asks SET status = ?, reply = ?, done_at = ? WHERE id = ?").run(status, reply.slice(0, 4000), now(), id);
    if (!cfg) finish("failed", "No model is set in Settings, so there's nothing to do this. Make it a task instead?");
    else {
      chat(cfg, [{ role: "system", content: RULES }, { role: "user", content: context ? `${text}\n\nIt's about this (${context.label}):\n${context.body.slice(0, 12_000)}` : text }], 300_000)
        .then((reply) => finish("done", reply.trim() || "Done."))
        .catch(() => finish("failed", "The assistant didn't answer. Try again, or make it a task."));
    }
    return get(id);
  }

  app.get("/api/asks", (c) => c.json({ asks: open() }));

  app.post("/api/asks", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    const text = String(b.text ?? "").trim();
    if (!text) return c.json({ error: "Say what you want done first." }, 400);
    let context: { label: string; body: string } | undefined;
    if (b.mail_id) {
      const m = db.prepare("SELECT * FROM mail WHERE id = ?").get(Number(b.mail_id)) as any;
      if (!m) return c.json({ error: "No such message." }, 404);
      context = { label: `email from ${m.from_name}: ${m.subject}`, body: `From: ${m.from_name} <${m.from_addr}>\nSubject: ${m.subject}\n\n${m.body}` };
    }
    return c.json(start(text, "app", context));
  });

  // It guessed wrong: this was a task for me after all.
  app.post("/api/asks/:id/task", async (c) => {
    const a = db.prepare("SELECT * FROM asks WHERE id = ?").get(Number(c.req.param("id"))) as any;
    if (!a) return c.json({ error: "That's gone." }, 404);
    const r = await ctx.capture(a.text, "app", { tasksOnly: true });
    if (a.context_label) for (const t of r.created) db.prepare("UPDATE tasks SET note = ? WHERE id = ?").run([t.note, `About the ${a.context_label}`].filter(Boolean).join(" · ").slice(0, 500), t.id);
    db.prepare("UPDATE asks SET cleared = 1 WHERE id = ?").run(a.id);
    return c.json(r);
  });

  app.delete("/api/asks/:id", (c) => c.json({ cleared: db.prepare("UPDATE asks SET cleared = 1 WHERE id = ?").run(Number(c.req.param("id"))).changes }));

  // The other way round: a task that should have gone to the assistant.
  app.post("/api/tasks/:id/ask", (c) => {
    const t = db.prepare("SELECT t.*, a.locked FROM tasks t JOIN areas a ON a.id = t.area_id WHERE t.id = ?").get(Number(c.req.param("id"))) as any;
    if (!t || t.locked) return c.json({ error: "No such task." }, 404);
    const ask = start([t.title, t.note].filter(Boolean).join("\n"), "app");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
    return c.json(ask);
  });

  return { start, open };
}
