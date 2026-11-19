import { Hono } from "hono";
import type { Db, Task, Area } from "./db.ts";
import { today } from "./db.ts";
import { rank } from "./rank.ts";
import { fileCapture, modelFromEnv, type Filed } from "./file.ts";

const EDITABLE = ["title", "note", "importance", "due", "minutes", "delegate", "area_id", "snoozed_until"] as const;

export function createApp(db: Db, now: () => Date = () => new Date()) {
  const app = new Hono();
  const day = () => today(now());

  const areas = () => db.prepare("SELECT * FROM areas ORDER BY sort").all() as Area[];
  const openTasks = () => db.prepare("SELECT * FROM tasks WHERE status = 'open' ORDER BY id").all() as Task[];
  const getTask = (id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;

  function insert(f: Filed, source: string): Task {
    const r = db
      .prepare(
        `INSERT INTO tasks (area_id, title, note, importance, due, minutes, delegate, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.area, f.title, f.note, f.importance, f.due, f.minutes, f.delegate, source, now().toISOString());
    return getTask(Number(r.lastInsertRowid))!;
  }

  app.get("/api/config", (c) =>
    c.json({ model: modelFromEnv()?.model ?? null, stt: Boolean(process.env.STT_URL) }),
  );

  // Everything the deck needs in one call.
  app.get("/api/deck", (c) => {
    const d = day();
    const tasks = openTasks();
    const lockedIds = new Set(areas().filter((a) => a.locked).map((a) => a.id));
    const ranked = rank(tasks, d);
    const next = ranked.slice(0, 3).map((r) => {
      // Locked areas never show their task text outside their own screen.
      const locked = lockedIds.has(r.task.area_id);
      return {
        id: r.task.id,
        area_id: r.task.area_id,
        title: locked ? "People: something due" : r.task.title,
        locked,
        why: locked ? [] : r.why,
      };
    });
    const needIds = new Set(ranked.map((r) => r.task.id));
    const deck = areas().map((a) => {
      const mine = tasks.filter((t) => t.area_id === a.id);
      const need = mine.filter((t) => needIds.has(t.id)).length;
      return {
        id: a.id,
        name: a.name,
        locked: Boolean(a.locked),
        need,
        items: a.locked
          ? []
          : mine.map((t) => ({ ...t, needs_you: needIds.has(t.id) })),
      };
    });
    const addedToday = (
      db.prepare("SELECT COUNT(*) AS n FROM captures WHERE created_at >= ? AND source != 'app'").get(d) as { n: number }
    ).n;
    return c.json({ today: d, next, areas: deck, addedToday });
  });

  // Quick-add: free text in, filed tasks out.
  app.post("/api/capture", async (c) => {
    const body = await c.req.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "Nothing to add: the text was empty." }, 400);
    if (text.length > 8000) return c.json({ error: "That's too long for one quick-add (8,000 characters max)." }, 400);
    const source = typeof body?.source === "string" ? body.source.slice(0, 40) : "app";
    const { items, via } = await fileCapture(text, day());
    db.prepare("INSERT INTO captures (text, source, via, created_at) VALUES (?, ?, ?, ?)").run(
      text, source, via, now().toISOString(),
    );
    const names = Object.fromEntries(areas().map((a) => [a.id, a.name]));
    const created = items.map((f) => insert(f, source)).map((t) => ({ ...t, area_name: names[t.area_id] }));
    return c.json({ via, created });
  });

  app.patch("/api/tasks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const t = getTask(id);
    if (!t) return c.json({ error: "That task no longer exists." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    if (body.status === "done" || body.status === "open") {
      db.prepare("UPDATE tasks SET status = ?, done_at = ? WHERE id = ?").run(
        body.status, body.status === "done" ? now().toISOString() : null, id,
      );
    }
    if (body.snooze === true) {
      const tomorrow = new Date(now());
      tomorrow.setDate(tomorrow.getDate() + 1);
      db.prepare("UPDATE tasks SET snoozed_until = ? WHERE id = ?").run(today(tomorrow), id);
    }
    for (const k of EDITABLE) {
      if (!(k in body)) continue;
      let v = body[k] as string | number | null;
      if (k === "title" && (typeof v !== "string" || !v.trim())) return c.json({ error: "A task needs a title." }, 400);
      if (k === "importance" && ![1, 2, 3].includes(v as number)) return c.json({ error: "Importance is 1, 2 or 3." }, 400);
      if ((k === "due" || k === "snoozed_until") && v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
        return c.json({ error: "Dates are YYYY-MM-DD." }, 400);
      if (k === "minutes" && v !== null && !(Number.isFinite(v) && (v as number) > 0))
        return c.json({ error: "Time needed is a number of minutes." }, 400);
      if (k === "area_id" && !areas().some((a) => a.id === v)) return c.json({ error: "Unknown area." }, 400);
      if (typeof v === "string") v = v.trim() || null;
      db.prepare(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, id);
    }
    return c.json(getTask(id));
  });

  app.delete("/api/tasks/:id", (c) => {
    const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(Number(c.req.param("id")));
    return r.changes ? c.json({ ok: true }) : c.json({ error: "That task no longer exists." }, 404);
  });

  // Voice: the browser records, this forwards the audio to a speech-to-text service you run.
  app.post("/api/transcribe", async (c) => {
    const stt = process.env.STT_URL;
    if (!stt) return c.json({ error: "Speech-to-text isn't set up yet (STT_URL)." }, 501);
    const form = await c.req.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!(audio instanceof File)) return c.json({ error: "No audio received." }, 400);
    const out = new FormData();
    out.set("file", audio, audio.name || "note.webm");
    out.set("model", process.env.STT_MODEL ?? "whisper-1");
    try {
      const res = await fetch(`${stt.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: process.env.STT_KEY ? { authorization: `Bearer ${process.env.STT_KEY}` } : {},
        body: out,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`speech service answered ${res.status}`);
      const body: any = await res.json();
      return c.json({ text: String(body.text ?? "").trim() });
    } catch (err) {
      return c.json({ error: `Couldn't transcribe: ${(err as Error).message}.` }, 502);
    }
  });

  return app;
}
