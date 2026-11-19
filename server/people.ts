// People: the relationships you're building and the outcomes you're working toward.
// Kept in its own database file, behind its own PIN, and only ever sent to People's own model.
import type { Hono } from "hono";
import Database from "better-sqlite3";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { Ctx } from "./app.ts";
import { chat, extractJson, type ChatMessage } from "./file.ts";
import { mountLock } from "./lock.ts";
import { dataDir, saveFile, serve, type StoredFile } from "./files.ts";

export const GRADES = ["O", "E", "C", "F", "?"] as const; // observed, established, clinical, folklore-that-works, contested
const FACT_GRADES = ["O:ben", "O:sys", "O:inf"]; // he said it, taken from a capture, the model's guess
export const OUTCOMES = ["hook", "close", "flake", "nothing"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Words inside quotation marks are kept verbatim as quotes. */
export function quotesIn(text: string): string[] {
  return [...text.matchAll(/[“"]([^”"]{2,400})[”"]/g)].map((m) => m[1].trim());
}

/** Split a markdown file into one chunk per heading. */
export function chunkMarkdown(text: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  let heading = "", body: string[] = [];
  const push = () => { if (body.join("").trim()) out.push({ heading, body: body.join("\n").trim() }); };
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) { push(); heading = h[1].trim(); body = []; } else body.push(line);
  }
  push();
  return out;
}

const STOP = new Set("the a an and or but if then to of in on at for with from by is are was were be been it this that she he they you i we her his their my our me him them as so not no do did does have has had about what when how".split(" "));
// Crude stemming so "hedging" matches "hedge" and "asking" matches "ask".
const stem = (w: string) => { const t = w.replace(/'s$/, "").replace(/(ing|ed|es|ly|s)$/, "").replace(/e$/, ""); return t.length >= 3 ? t : w; };
const words = (s: string) => (s.toLowerCase().match(/[a-z']{3,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem);

/** Rank library chunks by shared words with the question. Returns nothing rather than a near miss. */
export function retrieve<T extends { heading: string; body: string }>(chunks: T[], query: string, limit = 5): T[] {
  const q = new Set(words(query));
  if (!q.size) return [];
  return chunks
    .map((c) => {
      const w = words(c.heading + " " + c.heading + " " + c.body);
      const hits = w.filter((x) => q.has(x)).length;
      return { c, score: hits / Math.sqrt(w.length + 20), distinct: new Set(w.filter((x) => q.has(x))).size };
    })
    .filter((x) => x.distinct >= Math.min(2, q.size))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

const READING_RULES = `You help one person understand an interaction and decide what to do next. Be specific and a little uncomfortable; no platitudes.
Reply with ONLY a JSON object with these keys, in this order:
"what_happened": array of short strings, the sequence in order, quoting their exact words where quoted. No interpretation.
"readings": 1 to 3 objects {"text": a plausible reading, "grade": one of "O" (observed), "E" (established), "C" (clinical), "F" (folklore that works), "?" (contested), "wrong_if": what would show it's wrong}.
"change_my_mind": one sentence on what else would have to be true.
"brakes": one sentence checking for a cost in the moment (tired, cold, stressed, on display, being watched) before anything about interest.
"next_action": {"what": ONE concrete action, "when": "YYYY-MM-DD" or a named moment}. One action only.
"words": {"text": exact wording lifted from the library passages provided, "source": that passage's id} or null if no passage fits.
"no_quotes": true if the notes contain no direct quotes, else false. If true, say so in what_happened and ask for one.
Rules: no praise. One qualifier per claim. Quote before inference. Tell them plainly if they are talking too long, hedging, or avoiding the ask.`;

const TELL_RULES = `You keep a private record of the people in one person's life. They tell you things by text or voice.
Reply with ONLY a JSON object: {"reply": a short plain reply (ask ONE question if you need something clarified, otherwise confirm what you filed),
"actions": array of any of:
 {"type":"note","person":"<name exactly as in the known list>","text":"what happened, in their words","outcome":"hook"|"close"|"flake"|"nothing"|null},
 {"type":"new_person","name":"...","how_met":"..." or null},
 {"type":"thread","person":"<known name>","question":"an open question between them"},
 {"type":"fact","person":"<known name>","label":"e.g. Does, Likes, Avoid","value":"...","guess":true if you inferred it rather than being told}}
Only file a note under a person in the known list. If a name is new or could be two people, ask which before filing. Never invent details. Keep their exact quoted words in quotation marks.`;

export function mountPeople(app: Hono, ctx: Ctx) {
  const path = process.env.LA_DB === ":memory:" || process.env.VITEST ? ":memory:" : join(dataDir(), "people.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS person (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, how_met TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, person_id INTEGER, title TEXT NOT NULL, done_looks_like TEXT, stage TEXT,
      next_action TEXT, next_due TEXT, status TEXT NOT NULL DEFAULT 'open', task_id INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_people (goal_id INTEGER NOT NULL, person_id INTEGER NOT NULL, PRIMARY KEY (goal_id, person_id));
    CREATE TABLE IF NOT EXISTS step (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, done_at TEXT);
    CREATE TABLE IF NOT EXISTS interaction (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, person_id INTEGER NOT NULL, goal_id INTEGER, kind TEXT NOT NULL,
      text TEXT NOT NULL, outcome TEXT, quotes TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, file_id INTEGER, corrects_id INTEGER);
    CREATE TRIGGER IF NOT EXISTS interaction_immutable BEFORE UPDATE ON interaction BEGIN SELECT RAISE(ABORT, 'A filed record cannot be rewritten'); END;
    CREATE TABLE IF NOT EXISTS thread (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, question TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT);
    CREATE TABLE IF NOT EXISTS fact (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, grade TEXT NOT NULL, sensitive INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new');
    CREATE TABLE IF NOT EXISTS reading (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, person_id INTEGER, goal_id INTEGER, model TEXT NOT NULL, body TEXT NOT NULL, manifest TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, heading TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL);
  `);
  mountLock(app, ctx, "people");

  const now = () => ctx.now().toISOString();
  const person = (id: number) => db.prepare("SELECT * FROM person WHERE id = ?").get(id) as any;
  const byName = (name: string) => db.prepare("SELECT * FROM person WHERE lower(name) = lower(?)").get(name.trim()) as any;
  const goal = (id: number) => db.prepare("SELECT * FROM goal WHERE id = ?").get(id) as any;
  const lastSeen = (pid: number) => (db.prepare("SELECT max(ts) AS t FROM interaction WHERE person_id = ?").get(pid) as any)?.t as string | null;
  const daysSince = (iso: string | null) => (iso ? Math.floor((ctx.now().getTime() - new Date(iso).getTime()) / 86_400_000) : null);
  const bad = (c: any, msg: string, code = 400) => c.json({ error: msg }, code);

  // A dated next move also sits on the deck, where it shows only as "People: something due".
  function syncTask(g: any) {
    const wants = g.status === "open" && g.next_action && g.next_due && DATE.test(g.next_due);
    if (g.task_id) {
      if (wants) ctx.db.prepare("UPDATE tasks SET title = ?, due = ?, status = 'open', done_at = NULL WHERE id = ?").run(g.next_action, g.next_due, g.task_id);
      else ctx.db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?").run(now(), g.task_id);
    } else if (wants) {
      const r = ctx.db.prepare("INSERT INTO tasks (area_id, title, importance, due, source, created_at) VALUES ('people', ?, 3, ?, 'people', ?)").run(g.next_action, g.next_due, now());
      db.prepare("UPDATE goal SET task_id = ? WHERE id = ?").run(Number(r.lastInsertRowid), g.id);
    }
  }

  function addInteraction(pid: number, text: string, o: { kind?: string; outcome?: string | null; goal_id?: number | null; source?: string; file_id?: number | null; corrects_id?: number | null } = {}) {
    const r = db.prepare("INSERT INTO interaction (ts, person_id, goal_id, kind, text, outcome, quotes, source, file_id, corrects_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(now(), pid, o.goal_id ?? null, o.kind ?? "note", text.trim(), OUTCOMES.includes(o.outcome ?? "") ? o.outcome : null, JSON.stringify(quotesIn(text)), o.source ?? "app", o.file_id ?? null, o.corrects_id ?? null);
    return Number(r.lastInsertRowid);
  }

  const goalView = (g: any) => {
    const steps = db.prepare("SELECT * FROM step WHERE goal_id = ? ORDER BY position").all(g.id) as any[];
    const current = steps.find((s) => !s.done_at);
    const people = g.kind === "relationship" ? [person(g.person_id)] : (db.prepare("SELECT p.* FROM person p JOIN goal_people gp ON gp.person_id = p.id WHERE gp.goal_id = ?").all(g.id) as any[]);
    return { ...g, steps, current_step: current?.id ?? null, step_number: current ? steps.indexOf(current) + 1 : steps.length, people: people.filter(Boolean).map((p) => ({ id: p.id, name: p.name })), days_quiet: g.kind === "relationship" ? daysSince(lastSeen(g.person_id)) : null };
  };

  // ---- Home
  app.get("/api/people/home", (c) => {
    const goals = (db.prepare("SELECT * FROM goal WHERE status = 'open' ORDER BY next_due IS NULL, next_due, id").all() as any[]).map(goalView);
    const stale = (db.prepare("SELECT * FROM person").all() as any[]).map((p) => ({ id: p.id, name: p.name, days: daysSince(lastSeen(p.id)) })).filter((p) => p.days !== null && p.days >= 21);
    const next = goals.find((g) => g.next_action && g.next_due) ?? null;
    return c.json({
      next: next && { action: next.next_action, due: next.next_due, for: next.kind === "relationship" ? next.people[0]?.name : next.title, goal_id: next.id, kind: next.kind, person_id: next.person_id },
      relationships: goals.filter((g) => g.kind === "relationship"),
      scenarios: goals.filter((g) => g.kind === "scenario"),
      people: db.prepare("SELECT id, name FROM person ORDER BY name").all(),
      inbox: (db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").get() as any).n,
      stale, has_model: Boolean(ctx.modelFor("people_llm")), outcomes: OUTCOMES,
    });
  });

  // ---- People and what you're building with them
  app.post("/api/people/persons", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (typeof b.name !== "string" || !b.name.trim()) return bad(c, "Who is it?");
    if (byName(b.name)) return bad(c, "There's already someone with that name. Add something to tell them apart.", 409);
    const r = db.prepare("INSERT INTO person (name, how_met, created_at) VALUES (?, ?, ?)").run(b.name.trim().slice(0, 80), b.how_met?.trim() || null, now());
    const id = Number(r.lastInsertRowid);
    if (typeof b.building_toward === "string" && b.building_toward.trim())
      db.prepare("INSERT INTO goal (kind, person_id, title, created_at) VALUES ('relationship', ?, ?, ?)").run(id, b.building_toward.trim().slice(0, 300), now());
    return c.json(person(id));
  });

  app.get("/api/people/persons/:id", (c) => {
    const p = person(Number(c.req.param("id")));
    if (!p) return bad(c, "No such person.", 404);
    const log = (db.prepare("SELECT * FROM interaction WHERE person_id = ? ORDER BY id DESC").all(p.id) as any[]).map((i) => ({ ...i, quotes: JSON.parse(i.quotes) }));
    const g = db.prepare("SELECT * FROM goal WHERE kind = 'relationship' AND person_id = ? AND status = 'open'").get(p.id) as any;
    const reading = db.prepare("SELECT * FROM reading WHERE person_id = ? ORDER BY id DESC LIMIT 1").get(p.id) as any;
    return c.json({
      person: p, days_quiet: daysSince(lastSeen(p.id)), goal: g ? goalView(g) : null,
      scenarios: (db.prepare("SELECT g.* FROM goal g JOIN goal_people gp ON gp.goal_id = g.id WHERE gp.person_id = ? AND g.status = 'open'").all(p.id) as any[]).map((s) => ({ id: s.id, title: s.title })),
      threads: db.prepare("SELECT * FROM thread WHERE person_id = ? AND closed_at IS NULL ORDER BY id").all(p.id),
      quotes: log.flatMap((i) => i.quotes.map((q: string) => ({ text: q, ts: i.ts, grade: i.source === "app" ? "O:ben" : "O:sys" }))),
      facts: db.prepare("SELECT * FROM fact WHERE person_id = ? ORDER BY id").all(p.id),
      log, reading: reading ? { id: reading.id, ts: reading.ts } : null, outcomes: OUTCOMES,
    });
  });

  app.post("/api/people/goals", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (typeof b.title !== "string" || !b.title.trim()) return bad(c, b.kind === "scenario" ? "Name the outcome you want." : "Say what you want this to be.");
    if (b.kind === "relationship") {
      if (!person(Number(b.person_id))) return bad(c, "Pick the person.");
      if (db.prepare("SELECT 1 FROM goal WHERE kind = 'relationship' AND person_id = ? AND status = 'open'").get(b.person_id)) return bad(c, "You already have a goal with them. Edit that one.", 409);
      const r = db.prepare("INSERT INTO goal (kind, person_id, title, created_at) VALUES ('relationship', ?, ?, ?)").run(b.person_id, b.title.trim().slice(0, 300), now());
      return c.json(goalView(goal(Number(r.lastInsertRowid))));
    }
    if (b.kind !== "scenario") return bad(c, "Is this a relationship or a scenario?");
    const r = db.prepare("INSERT INTO goal (kind, title, done_looks_like, created_at) VALUES ('scenario', ?, ?, ?)").run(b.title.trim().slice(0, 300), b.done_looks_like?.trim() || null, now());
    const id = Number(r.lastInsertRowid);
    for (const pid of Array.isArray(b.people) ? b.people : []) if (person(Number(pid))) db.prepare("INSERT OR IGNORE INTO goal_people VALUES (?, ?)").run(id, Number(pid));
    (Array.isArray(b.steps) ? b.steps : []).filter((s: unknown) => typeof s === "string" && s.trim()).forEach((s: string, i: number) => db.prepare("INSERT INTO step (goal_id, position, title) VALUES (?, ?, ?)").run(id, i, s.trim().slice(0, 200)));
    return c.json(goalView(goal(id)));
  });

  app.get("/api/people/goals/:id", (c) => {
    const g = goal(Number(c.req.param("id")));
    if (!g) return bad(c, "No such goal.", 404);
    const log = (db.prepare("SELECT i.*, p.name AS person_name FROM interaction i JOIN person p ON p.id = i.person_id WHERE i.goal_id = ? ORDER BY i.id DESC").all(g.id) as any[]).map((i) => ({ ...i, quotes: JSON.parse(i.quotes) }));
    const chunks = db.prepare("SELECT id, doc, heading, body FROM library").all() as any[];
    return c.json({ goal: goalView(g), log, library: retrieve(chunks, `${g.title} ${g.done_looks_like ?? ""}`).map((x) => ({ id: x.id, doc: x.doc, heading: x.heading })), people: db.prepare("SELECT id, name FROM person ORDER BY name").all() });
  });

  app.patch("/api/people/goals/:id", async (c) => {
    const g = goal(Number(c.req.param("id")));
    if (!g) return bad(c, "No such goal.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const next = { ...g };
    for (const k of ["title", "done_looks_like", "stage", "next_action", "next_due"]) if (k in b) next[k] = typeof b[k] === "string" && b[k].trim() ? b[k].trim().slice(0, 500) : null;
    if (!next.title) return bad(c, "It needs a name.");
    if (next.next_due && !DATE.test(next.next_due)) return bad(c, "Dates are YYYY-MM-DD.");
    // A next move is a date or a named re-ask. Anything vaguer isn't a next move.
    if (next.next_action && !next.next_due && !/\b(re-?ask|ask again|when (she|he|they) (says?|brings?|asks?))\b/i.test(next.next_action)) return bad(c, "Name a time or a re-ask.");
    if (b.status === "done" || b.status === "open") next.status = b.status;
    db.prepare("UPDATE goal SET title = ?, done_looks_like = ?, stage = ?, next_action = ?, next_due = ?, status = ? WHERE id = ?").run(next.title, next.done_looks_like, next.stage, next.next_action, next.next_due, next.status, g.id);
    if (Array.isArray(b.people) && g.kind === "scenario") {
      db.prepare("DELETE FROM goal_people WHERE goal_id = ?").run(g.id);
      for (const pid of b.people) if (person(Number(pid))) db.prepare("INSERT OR IGNORE INTO goal_people VALUES (?, ?)").run(g.id, Number(pid));
    }
    syncTask(goal(g.id));
    return c.json(goalView(goal(g.id)));
  });

  app.post("/api/people/goals/:id/steps", async (c) => {
    const g = goal(Number(c.req.param("id")));
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (!g || g.kind !== "scenario") return bad(c, "No such scenario.", 404);
    if (typeof b.title !== "string" || !b.title.trim()) return bad(c, "Name the step.");
    const pos = ((db.prepare("SELECT max(position) AS m FROM step WHERE goal_id = ?").get(g.id) as any).m ?? -1) + 1;
    db.prepare("INSERT INTO step (goal_id, position, title) VALUES (?, ?, ?)").run(g.id, pos, b.title.trim().slice(0, 200));
    return c.json(goalView(g));
  });

  // Steps go in order: only the one you're on can be finished.
  app.post("/api/people/steps/:id/done", (c) => {
    const s = db.prepare("SELECT * FROM step WHERE id = ?").get(Number(c.req.param("id"))) as any;
    if (!s) return bad(c, "No such step.", 404);
    const current = db.prepare("SELECT id FROM step WHERE goal_id = ? AND done_at IS NULL ORDER BY position LIMIT 1").get(s.goal_id) as any;
    if (current?.id !== s.id) return bad(c, "Finish the step you're on first.");
    db.prepare("UPDATE step SET done_at = ? WHERE id = ?").run(now(), s.id);
    return c.json(goalView(goal(s.goal_id)));
  });

  // ---- The record
  app.post("/api/people/interactions", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let b: any, fileId: number | null = null;
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      b = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
      const f = form.get("file");
      if (f instanceof File && f.size) {
        try { fileId = (await saveFile(ctx, f, "people")).id; } catch (e) { return bad(c, (e as Error).message); }
      }
    } else b = (await c.req.json().catch(() => ({}))) as any;
    const p = person(Number(b.person_id));
    if (!p) return bad(c, "Pick who this is about.");
    const text = String(b.text ?? "").trim();
    if (!text && !fileId) return bad(c, "Say what happened.");
    const id = addInteraction(p.id, text || "(screenshot, not yet written up)", { kind: fileId ? "screenshot" : b.kind === "voice" ? "voice" : "note", outcome: b.outcome, goal_id: b.goal_id ? Number(b.goal_id) : null, file_id: fileId, corrects_id: b.corrects_id ? Number(b.corrects_id) : null });
    if (b.inbox_id) db.prepare("UPDATE inbox SET status = 'filed' WHERE id = ?").run(Number(b.inbox_id));
    return c.json({ id });
  });

  app.get("/api/people/files/:id", (c) => {
    const f = ctx.db.prepare("SELECT * FROM files WHERE id = ? AND owner = 'people'").get(Number(c.req.param("id"))) as StoredFile | undefined;
    return f ? serve(f) : bad(c, "No such file.", 404);
  });

  app.post("/api/people/threads", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (!person(Number(b.person_id))) return bad(c, "Pick the person.");
    if (typeof b.question !== "string" || !b.question.trim()) return bad(c, "What's the open question?");
    db.prepare("INSERT INTO thread (person_id, question, opened_at) VALUES (?, ?, ?)").run(b.person_id, b.question.trim().slice(0, 300), now());
    return c.json({ ok: true });
  });
  app.post("/api/people/threads/:id/close", (c) => (db.prepare("UPDATE thread SET closed_at = ? WHERE id = ? AND closed_at IS NULL").run(now(), Number(c.req.param("id"))).changes ? c.json({ ok: true }) : bad(c, "No such open thread.", 404)));

  app.post("/api/people/facts", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (!person(Number(b.person_id))) return bad(c, "Pick the person.");
    if (!b.label?.trim() || !b.value?.trim()) return bad(c, "It needs a label and a value.");
    db.prepare("INSERT INTO fact (person_id, label, value, grade, sensitive, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(b.person_id, b.label.trim().slice(0, 40), b.value.trim().slice(0, 300), FACT_GRADES.includes(b.grade) ? b.grade : "O:ben", b.sensitive ? 1 : 0, now());
    return c.json({ ok: true });
  });
  // Confirming a guess makes it yours.
  app.post("/api/people/facts/:id/confirm", (c) => (db.prepare("UPDATE fact SET grade = 'O:ben' WHERE id = ?").run(Number(c.req.param("id"))).changes ? c.json({ ok: true }) : bad(c, "No such entry.", 404)));
  app.delete("/api/people/facts/:id", (c) => (db.prepare("DELETE FROM fact WHERE id = ?").run(Number(c.req.param("id"))).changes ? c.json({ ok: true }) : bad(c, "No such entry.", 404)));

  // ---- Handed over from Hermes: write-only from outside, read only in here.
  app.post("/api/people-drop", async (c) => {
    const token = ctx.secret.get("relay_token");
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) return bad(c, "Wrong or missing relay token.", 401);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const items = (Array.isArray(b.items) ? b.items : [b.text]).filter((t: unknown) => typeof t === "string" && t.trim());
    if (!items.length) return bad(c, "Send the notes as \"text\" or as a list in \"items\".");
    for (const t of items.slice(0, 500)) db.prepare("INSERT INTO inbox (ts, source, text) VALUES (?, ?, ?)").run(now(), String(b.source ?? "hermes").slice(0, 40), String(t).trim().slice(0, 20000));
    return c.json({ received: Math.min(items.length, 500) }); // nothing about People is ever sent back
  });
  app.get("/api/people/inbox", (c) => c.json({ items: db.prepare("SELECT * FROM inbox WHERE status = 'new' ORDER BY id").all(), people: db.prepare("SELECT id, name FROM person ORDER BY name").all() }));
  app.post("/api/people/inbox/:id/skip", (c) => (db.prepare("UPDATE inbox SET status = 'skipped' WHERE id = ?").run(Number(c.req.param("id"))).changes ? c.json({ ok: true }) : bad(c, "Already dealt with.", 404)));

  // ---- Library
  app.post("/api/people/library", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const files = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File);
    if (!files.length) return bad(c, "Choose one or more text or markdown files.");
    let chunks = 0;
    for (const f of files) {
      if (f.size > 2 * 1024 * 1024) return bad(c, `${f.name} is over 2 MB.`);
      db.prepare("DELETE FROM library WHERE doc = ?").run(f.name);
      for (const ch of chunkMarkdown(await f.text())) { db.prepare("INSERT INTO library (doc, heading, body) VALUES (?, ?, ?)").run(f.name, ch.heading || f.name, ch.body.slice(0, 8000)); chunks++; }
    }
    return c.json({ files: files.length, passages: chunks });
  });
  app.get("/api/people/library", (c) => {
    const q = c.req.query("q")?.trim();
    const all = db.prepare("SELECT id, doc, heading, body FROM library").all() as any[];
    if (q) return c.json({ results: retrieve(all, q, 12).map((x) => ({ id: x.id, doc: x.doc, heading: x.heading })) });
    const docs = new Map<string, number>();
    for (const x of all) docs.set(x.doc, (docs.get(x.doc) ?? 0) + 1);
    return c.json({ docs: [...docs.entries()].map(([doc, passages]) => ({ doc, passages })) });
  });
  app.get("/api/people/library/:id", (c) => {
    const x = db.prepare("SELECT * FROM library WHERE id = ?").get(Number(c.req.param("id")));
    return x ? c.json(x) : bad(c, "That passage is gone.", 404);
  });
  app.delete("/api/people/library", (c) => c.json({ removed: db.prepare("DELETE FROM library WHERE doc = ?").run(c.req.query("doc") ?? "").changes }));

  // ---- Tell it: a chat that files what you say
  app.get("/api/people/chat", (c) => c.json({ messages: (db.prepare("SELECT * FROM chat ORDER BY id DESC LIMIT 40").all() as any[]).reverse() }));
  app.post("/api/people/tell", async (c) => {
    const cfg = ctx.modelFor("people_llm");
    if (!cfg) return bad(c, "Set a model for People in Settings to use this. Until then, add notes from a person's page.");
    const b = (await c.req.json().catch(() => ({}))) as any;
    const text = String(b.text ?? "").trim();
    if (!text) return bad(c, "Say or type something first.");
    const known = (db.prepare("SELECT name FROM person ORDER BY name").all() as any[]).map((p) => p.name);
    const history = (db.prepare("SELECT role, text FROM chat ORDER BY id DESC LIMIT 8").all() as any[]).reverse();
    const messages: ChatMessage[] = [
      { role: "system", content: `${TELL_RULES}\nKnown people: ${JSON.stringify(known)}` },
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.text })),
      { role: "user", content: text },
    ];
    let parsed: any;
    try { parsed = extractJson(await chat(cfg, messages, 90_000)); } catch (e) { return bad(c, `People's model didn't help: ${(e as Error).message}.`, 502); }
    const did: string[] = [];
    for (const a of Array.isArray(parsed?.actions) ? parsed.actions.slice(0, 12) : []) {
      if (a?.type === "new_person" && typeof a.name === "string" && a.name.trim() && !byName(a.name)) {
        db.prepare("INSERT INTO person (name, how_met, created_at) VALUES (?, ?, ?)").run(a.name.trim().slice(0, 80), typeof a.how_met === "string" ? a.how_met.slice(0, 200) : null, now());
        did.push(`Added ${a.name.trim()}`);
        continue;
      }
      const p = typeof a?.person === "string" ? byName(a.person) : null;
      if (!p) continue; // never file under a name that isn't already known
      if (a.type === "note" && typeof a.text === "string" && a.text.trim()) { addInteraction(p.id, a.text, { kind: "chat", outcome: a.outcome, source: "app" }); did.push(`Note filed under ${p.name}`); }
      else if (a.type === "thread" && typeof a.question === "string" && a.question.trim()) { db.prepare("INSERT INTO thread (person_id, question, opened_at) VALUES (?, ?, ?)").run(p.id, a.question.trim().slice(0, 300), now()); did.push(`Open question added for ${p.name}`); }
      else if (a.type === "fact" && a.label && a.value) { db.prepare("INSERT INTO fact (person_id, label, value, grade, created_at) VALUES (?, ?, ?, ?, ?)").run(p.id, String(a.label).slice(0, 40), String(a.value).slice(0, 300), a.guess ? "O:inf" : "O:ben", now()); did.push(`${a.guess ? "Guess" : "Detail"} added for ${p.name}`); }
    }
    const reply = typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : did.length ? "Filed." : "I didn't file anything from that.";
    db.prepare("INSERT INTO chat (ts, role, text) VALUES (?, 'user', ?)").run(now(), text);
    db.prepare("INSERT INTO chat (ts, role, text) VALUES (?, 'assistant', ?)").run(now(), reply);
    return c.json({ reply, did });
  });

  // ---- Readings
  app.post("/api/people/readings", async (c) => {
    const cfg = ctx.modelFor("people_llm");
    if (!cfg) return bad(c, "Set a model for People in Settings to get readings.");
    const b = (await c.req.json().catch(() => ({}))) as any;
    const g = b.goal_id ? goal(Number(b.goal_id)) : null;
    const p = person(Number(b.person_id ?? g?.person_id));
    if (!p && !g) return bad(c, "Pick a person or a scenario.");
    const where = g && g.kind === "scenario" ? ["goal_id = ?", g.id] : ["person_id = ?", p.id];
    const recent = (db.prepare(`SELECT * FROM interaction WHERE ${where[0]} ORDER BY id DESC LIMIT 2`).all(where[1]) as any[]).reverse();
    if (!recent.length) return bad(c, "There's nothing recorded to read yet. Add a note first.");
    const threads = p ? (db.prepare("SELECT question FROM thread WHERE person_id = ? AND closed_at IS NULL").all(p.id) as any[]).map((t) => t.question) : [];
    const view = g ? goalView(g) : null;
    const chunks = retrieve(db.prepare("SELECT id, doc, heading, body FROM library").all() as any[], `${recent.map((r) => r.text).join(" ")} ${g?.title ?? ""}`);
    const notAllowed = view?.steps.filter((s: any) => !s.done_at && s.id !== view.current_step).map((s: any) => s.title) ?? [];
    const material = [
      g ? `${g.kind === "scenario" ? "Outcome wanted" : "Building toward"}: ${g.title}` : "",
      view?.current_step ? `Current step: ${view.steps.find((s: any) => s.id === view.current_step).title}. Not yet allowed (later steps): ${notAllowed.join("; ") || "none"}.` : "",
      `Notes, oldest first:\n${recent.map((r) => `- ${r.ts.slice(0, 10)}${r.outcome ? ` [${r.outcome}]` : ""}: ${r.text}`).join("\n")}`,
      threads.length ? `Open questions: ${threads.join("; ")}` : "",
      chunks.length ? `Library passages:\n${chunks.map((x) => `[${x.id}] ${x.heading}: ${x.body.slice(0, 1200)}`).join("\n\n")}` : "Library passages: none relevant. Set \"words\" to null.",
      `Today is ${ctx.day()}.`,
    ].filter(Boolean).join("\n\n");
    let body: any;
    try { body = extractJson(await chat(cfg, [{ role: "system", content: READING_RULES }, { role: "user", content: material }], 120_000)); } catch (e) { return bad(c, `People's model didn't help: ${(e as Error).message}.`, 502); }
    if (!body || !Array.isArray(body.readings)) return bad(c, "People's model answered in the wrong shape. Try again.", 502);
    body.readings = body.readings.slice(0, 3).map((r: any) => ({ text: String(r?.text ?? ""), wrong_if: String(r?.wrong_if ?? ""), grade: GRADES.includes(r?.grade) ? r.grade : null }));
    if (body.words && !chunks.some((x) => x.id === Number(body.words.source))) body.words = null; // a citation must point at a passage that was actually sent
    const manifest = { notes: recent.length, person: p?.name ?? null, open_questions: threads.length, passages: chunks.map((x) => ({ id: x.id, title: `${x.doc} › ${x.heading}` })), characters: material.length };
    const r = db.prepare("INSERT INTO reading (ts, person_id, goal_id, model, body, manifest) VALUES (?, ?, ?, ?, ?, ?)").run(now(), p?.id ?? null, g?.id ?? null, cfg.model, JSON.stringify(body), JSON.stringify(manifest));
    return c.json({ id: Number(r.lastInsertRowid) });
  });

  const readingView = (r: any) => ({ ...r, body: JSON.parse(r.body), manifest: JSON.parse(r.manifest), accepted: Boolean(r.accepted), grades: GRADES });
  app.get("/api/people/readings/:id", (c) => {
    const r = db.prepare("SELECT * FROM reading WHERE id = ?").get(Number(c.req.param("id")));
    return r ? c.json(readingView(r)) : bad(c, "No such reading.", 404);
  });
  app.get("/api/people/readings", (c) => {
    const pid = Number(c.req.query("person_id")), gid = Number(c.req.query("goal_id"));
    const r = gid ? db.prepare("SELECT * FROM reading WHERE goal_id = ? ORDER BY id DESC LIMIT 1").get(gid) : db.prepare("SELECT * FROM reading WHERE person_id = ? ORDER BY id DESC LIMIT 1").get(pid);
    return c.json({ reading: r ? readingView(r) : null });
  });

  // Grade any claim the model left ungraded, then accept. Accepting sets the next move.
  app.patch("/api/people/readings/:id", async (c) => {
    const r = db.prepare("SELECT * FROM reading WHERE id = ?").get(Number(c.req.param("id"))) as any;
    if (!r) return bad(c, "No such reading.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const body = JSON.parse(r.body);
    if (b.grade && Number.isInteger(b.grade.index) && body.readings[b.grade.index]) {
      if (!GRADES.includes(b.grade.value)) return bad(c, "Pick one of the five grades.");
      body.readings[b.grade.index].grade = b.grade.value;
      db.prepare("UPDATE reading SET body = ? WHERE id = ?").run(JSON.stringify(body), r.id);
    }
    if (b.accept) {
      const missing = body.readings.filter((x: any) => !x.grade).length;
      if (missing) return bad(c, `${missing} claim${missing === 1 ? " still needs" : "s still need"} a grade first.`);
      db.prepare("UPDATE reading SET accepted = 1 WHERE id = ?").run(r.id);
      const g = r.goal_id ? goal(r.goal_id) : db.prepare("SELECT * FROM goal WHERE kind = 'relationship' AND person_id = ? AND status = 'open'").get(r.person_id);
      const na = body.next_action;
      if (g && na?.what) {
        const due = DATE.test(String(na.when)) ? na.when : null;
        db.prepare("UPDATE goal SET next_action = ?, next_due = ? WHERE id = ?").run(due ? String(na.what).slice(0, 300) : `${String(na.what).slice(0, 250)} (${na.when ?? "no date set"})`, due, (g as any).id);
        syncTask(goal((g as any).id));
      }
    }
    return c.json(readingView(db.prepare("SELECT * FROM reading WHERE id = ?").get(r.id)));
  });
}
