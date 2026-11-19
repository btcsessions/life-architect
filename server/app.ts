import { Hono } from "hono";
import type { Db, Task, Area } from "./db.ts";
import { today } from "./db.ts";
import { rank } from "./rank.ts";
import { fileCapture, type Filed, type ModelConfig } from "./file.ts";

/** Settings the user can change in the app. Each falls back to the environment variable of the same name. */
const SETTING_KEYS = ["llm_url", "llm_key", "llm_model", "stt_url", "stt_key", "stt_model"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];
const SECRET: SettingKey[] = ["llm_key", "stt_key"];

const EDITABLE = ["title", "note", "importance", "due", "minutes", "delegate", "area_id", "snoozed_until"] as const;

export function createApp(db: Db, now: () => Date = () => new Date()) {
  const app = new Hono();
  const day = () => today(now());

  const setting = (k: SettingKey): string => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined;
    return (row?.value ?? process.env[k.toUpperCase()] ?? "").trim();
  };
  const model = (): ModelConfig | null => {
    const url = setting("llm_url").replace(/\/$/, "");
    const name = setting("llm_model");
    return url && name ? { url, model: name, key: setting("llm_key") || undefined } : null;
  };

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
    c.json({ model: model()?.model ?? null, stt: Boolean(setting("stt_url")) }),
  );

  // Keys are write-only: the app can tell whether one is saved, never read it back.
  const settingsView = () =>
    Object.fromEntries(SETTING_KEYS.map((k) => (SECRET.includes(k) ? [`${k}_set`, Boolean(setting(k))] : [k, setting(k)])));

  app.get("/api/settings", (c) => c.json(settingsView()));

  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "Nothing to save." }, 400);
    for (const k of SETTING_KEYS) {
      if (!(k in body)) continue;
      const v = body[k];
      if (typeof v !== "string" || v.length > 2000) return c.json({ error: `"${k}" must be text.` }, 400);
      if (k.endsWith("_url") && v.trim() && !/^https?:\/\/\S+$/.test(v.trim()))
        return c.json({ error: "An address starts with http:// or https://" }, 400);
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v.trim());
    }
    return c.json(settingsView());
  });

  // List the models an address offers, so the name can be picked instead of typed.
  // Uses the address and key being typed if given, otherwise the saved ones.
  app.post("/api/settings/models", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const url = (typeof body.llm_url === "string" && body.llm_url.trim() ? body.llm_url.trim() : setting("llm_url")).replace(/\/$/, "");
    const key = typeof body.llm_key === "string" && body.llm_key.trim() ? body.llm_key.trim() : setting("llm_key");
    if (!/^https?:\/\/\S+$/.test(url)) return c.json({ ok: false, models: [], message: "Enter the address first." });
    try {
      const res = await fetch(`${url}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403)
        return c.json({ ok: false, models: [], message: "It answered, but wants a key before listing models. Enter the key and try again." });
      if (res.status === 404)
        return c.json({ ok: false, models: [], message: "Reached the server, but it has no model list at that address. It usually ends in /v1." });
      if (!res.ok) return c.json({ ok: false, models: [], message: `It answered with an error (${res.status}).` });
      const data: any = await res.json().catch(() => null);
      const list: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
      const models = [...new Set(list.map((m: any) => (typeof m === "string" ? m : m?.id ?? m?.name)).filter((m) => typeof m === "string" && m))].sort() as string[];
      if (!models.length) return c.json({ ok: false, models: [], message: "It answered, but listed no models. Type the name instead." });
      return c.json({ ok: true, models, message: `Found ${models.length} model${models.length === 1 ? "" : "s"}.` });
    } catch (err) {
      const e = err as Error;
      return c.json({ ok: false, models: [], message: e.name === "TimeoutError" ? "No answer within 15 seconds." : `Couldn't reach it: ${e.message}.` });
    }
  });

  // One tiny request, so a wrong address or key is found here and not on the next quick-add.
  app.post("/api/settings/test", async (c) => {
    const m = model();
    if (!m) return c.json({ ok: false, message: "Enter an address and a model name first." });
    try {
      const res = await fetch(`${m.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(m.key ? { authorization: `Bearer ${m.key}` } : {}) },
        body: JSON.stringify({ model: m.model, messages: [{ role: "user", content: "Reply with the single word: ready" }] }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.status === 401 || res.status === 403) return c.json({ ok: false, message: "It answered, but refused the key." });
      if (res.status === 404) return c.json({ ok: false, message: "Reached the server, but not at that address. It usually ends in /v1." });
      if (!res.ok) return c.json({ ok: false, message: `It answered with an error (${res.status}): ${(await res.text()).slice(0, 200)}` });
      const body: any = await res.json().catch(() => null);
      const reply = body?.choices?.[0]?.message?.content;
      if (typeof reply !== "string") return c.json({ ok: false, message: "It answered, but not in the expected format." });
      return c.json({ ok: true, message: `Connected. It replied: "${reply.trim().slice(0, 80)}"` });
    } catch (err) {
      const e = err as Error;
      return c.json({ ok: false, message: e.name === "TimeoutError" ? "No answer within 45 seconds." : `Couldn't reach it: ${e.message}.` });
    }
  });

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
    const { items, via } = await fileCapture(text, day(), model());
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
    const stt = setting("stt_url");
    if (!stt) return c.json({ error: "Speech-to-text isn't set up yet. Add it in Settings." }, 501);
    const form = await c.req.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!(audio instanceof File)) return c.json({ error: "No audio received." }, 400);
    const out = new FormData();
    out.set("file", audio, audio.name || "note.webm");
    out.set("model", setting("stt_model") || "whisper-1");
    try {
      const res = await fetch(`${stt.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: setting("stt_key") ? { authorization: `Bearer ${setting("stt_key")}` } : {},
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
