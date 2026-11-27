// People: the relationships you're building and the outcomes you're working toward.
// Kept in its own database file, behind its own PIN, and only ever sent to People's own model.
import type { Hono } from "hono";
import Database from "better-sqlite3";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./app.ts";
import { chat, extractJson, type ChatMessage } from "./file.ts";
import { mountLock } from "./lock.ts";
import { dataDir, saveFile, serve, type StoredFile } from "./files.ts";
import { pdfLines } from "./pdf.ts";

export const GRADES = ["O", "E", "C", "F", "?"] as const; // observed, established, clinical, folklore-that-works, contested
const FACT_GRADES = ["O:ben", "O:sys", "O:inf"]; // he said it, taken from a capture, the model's guess
export const OUTCOMES = ["hook", "close", "flake", "nothing"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const quietText = (d: number | null) => (d === null ? "nothing recorded" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);
/** A bearer token compared in constant time. An unset token never matches. */
function tokenIs(header: string | undefined, token: string | null): boolean {
  const given = header?.replace(/^Bearer\s+/i, "") ?? "";
  return Boolean(token) && given.length === token!.length && timingSafeEqual(Buffer.from(given), Buffer.from(token!));
}

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

const ASK_RULES = `You are one person's private guide on the relationships he's building and the social outcomes he wants. You also keep the record behind it.
He either asks you something, or hands you context (what happened, a pasted chat, a document, a screenshot), or both.
Reply with ONLY a JSON object: {"reply": ..., "actions": [...]}.
"reply": if he asked something, answer it directly: plain, specific, a little uncomfortable, no praise, no platitudes, at most 6 short sentences, ending with one concrete next step when there is one. If he only gave context, confirm in one line what you filed. If something essential is unclear (who a name is, what happened), ask ONE question.
"actions": what to file, any of:
 {"type":"note","person":"<name exactly as in the known list>","text":"what happened, in his words","outcome":"hook"|"close"|"flake"|"nothing"|null},
 {"type":"new_person","name":"...","how_met":"..." or null},
 {"type":"goal","person":"<known name>","text":"what he wants this relationship to become"} (only when he says it),
 {"type":"thread","person":"<known name>","question":"an open question between them"},
 {"type":"fact","person":"<known name>","label":"e.g. Does, Likes, Avoid","value":"...","guess":true if you inferred it rather than being told},
 {"type":"next","person":"<known name>","what":"one concrete next step","when":"YYYY-MM-DD" or a named moment} (only when he agrees to one or asks you to set it).
If images are attached (usually screenshots of a chat), read them. Put what they show into any note you file, with who said what in their exact words in quotation marks, so the record keeps it. Add "saw_images": true if you could read them, false if you couldn't (then say so in the reply).
A pure question files nothing. Only file under a person in the known list; if a name is new or could be two people, ask before filing. Never invent details. Keep their exact quoted words in quotation marks.`;

const BRIEF_RULES = `You guide one person on the relationships he's building and the social outcomes he's working toward. You get a short summary of each, keyed like [p:3] or [g:5].
Be specific and direct, a little uncomfortable; no praise, no platitudes, nothing generic. Use only what's given; where something is missing, say what to find out.
Reply with ONLY a JSON object:
{"summary": one or two sentences on the overall picture and what matters most right now,
 "do_now": up to 3 objects {"what": one concrete action, "key": the item's key, "when": "YYYY-MM-DD" or a named moment}, only things that need doing in the next few days,
 "points": up to 3 short guidance points across everything (patterns, what he's neglecting, where he's overinvesting),
 "items": one object per item given: {"key": its key, "guidance": 1 to 3 short points specific to it, "next": one next step}}`;

const GUIDE_RULES = `You guide one person on one relationship or one outcome he wants. You get the full record. Be specific and direct, a little uncomfortable; no praise, no platitudes.
Reply with ONLY a JSON object:
{"read": one or two sentences on where this really stands, quoting their words where it matters,
 "points": 2 to 4 specific guidance points,
 "watch_for": one sign that would change the approach,
 "next": {"what": ONE concrete action, "when": "YYYY-MM-DD" or a named moment},
 "words": {"text": exact wording lifted from a library passage provided, "source": that passage's id} or null if none fits}`;

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
  // The record itself can't be rewritten, but a note can move to another person when two entries turn out to be one.
  db.exec(`DROP TRIGGER IF EXISTS interaction_immutable;
    CREATE TRIGGER interaction_immutable BEFORE UPDATE OF text, ts, quotes, kind, source ON interaction BEGIN SELECT RAISE(ABORT, 'A filed record cannot be rewritten'); END;
    CREATE TABLE IF NOT EXISTS import_seen (hash TEXT PRIMARY KEY);`);
  if (!(db.prepare("PRAGMA table_info(person)").all() as Array<{ name: string }>).some((c) => c.name === "imported")) db.exec("ALTER TABLE person ADD COLUMN imported INTEGER NOT NULL DEFAULT 0");
  // The guidance layer: one brief across everything, and a deeper guide per person or scenario when asked.
  db.exec(`CREATE TABLE IF NOT EXISTS brief (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, basis TEXT NOT NULL, model TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guide (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, target TEXT NOT NULL, model TEXT NOT NULL, body TEXT NOT NULL);`);
  if (!(db.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).some((c) => c.name === "file_id")) db.exec("ALTER TABLE inbox ADD COLUMN file_id INTEGER");
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

  function addInteraction(pid: number, text: string, o: { kind?: string; outcome?: string | null; goal_id?: number | null; source?: string; file_id?: number | null; corrects_id?: number | null; ts?: string } = {}) {
    const r = db.prepare("INSERT INTO interaction (ts, person_id, goal_id, kind, text, outcome, quotes, source, file_id, corrects_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(o.ts ?? now(), pid, o.goal_id ?? null, o.kind ?? "note", text.trim(), OUTCOMES.includes(o.outcome ?? "") ? o.outcome : null, JSON.stringify(quotesIn(text)), o.source ?? "app", o.file_id ?? null, o.corrects_id ?? null);
    return Number(r.lastInsertRowid);
  }

  const goalView = (g: any) => {
    const steps = db.prepare("SELECT * FROM step WHERE goal_id = ? ORDER BY position").all(g.id) as any[];
    const current = steps.find((s) => !s.done_at);
    const people = g.kind === "relationship" ? [person(g.person_id)] : (db.prepare("SELECT p.* FROM person p JOIN goal_people gp ON gp.person_id = p.id WHERE gp.goal_id = ?").all(g.id) as any[]);
    return { ...g, steps, current_step: current?.id ?? null, step_number: current ? steps.indexOf(current) + 1 : steps.length, people: people.filter(Boolean).map((p) => ({ id: p.id, name: p.name })), days_quiet: g.kind === "relationship" ? daysSince(lastSeen(g.person_id)) : null };
  };

  /**
   * Takes a hand-over. A plain string goes to the unsorted pile. An object naming a person is filed straight onto
   * that person (created if new): {"person","text","date"?,"type"?: "note"|"fact"|"question"|"goal"|"met","label"?,"outcome"?}.
   * Sending the same thing twice files it once.
   */
  function handOver(items: unknown[], source: string) {
    const out = { received: 0, filed: 0, unsorted: 0, people_created: 0, duplicates: 0 };
    const src = source.slice(0, 40);
    db.transaction(() => {
      for (const it of items) {
        const o = typeof it === "string" ? { text: it } : it && typeof it === "object" ? (it as any) : null;
        const text = typeof o?.text === "string" ? o.text.trim().slice(0, 20_000) : "";
        const type = ["note", "fact", "question", "goal", "met"].includes(o?.type) ? o.type : "note";
        if (!text) continue;
        out.received++;
        const name = typeof o.person === "string" ? o.person.trim().slice(0, 80) : "";
        const hash = createHash("sha256").update([name.toLowerCase(), type, o.label ?? "", text].join("|")).digest("hex");
        if (!db.prepare("INSERT OR IGNORE INTO import_seen (hash) VALUES (?)").run(hash).changes) { out.duplicates++; continue; }
        if (!name) { db.prepare("INSERT INTO inbox (ts, source, text) VALUES (?, ?, ?)").run(now(), src, text); out.unsorted++; continue; }
        let p = byName(name);
        if (!p) { p = person(Number(db.prepare("INSERT INTO person (name, created_at, imported) VALUES (?, ?, 1)").run(name, now()).lastInsertRowid)); out.people_created++; }
        const d = typeof o.date === "string" && !Number.isNaN(Date.parse(o.date)) ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(o.date) ? `${o.date}T12:00:00` : o.date).toISOString() : undefined;
        if (type === "fact") db.prepare("INSERT INTO fact (person_id, label, value, grade, created_at) VALUES (?, ?, ?, 'O:sys', ?)").run(p.id, String(o.label ?? "Note").slice(0, 40), text.slice(0, 500), now());
        else if (type === "question") db.prepare("INSERT INTO thread (person_id, question, opened_at) VALUES (?, ?, ?)").run(p.id, text.slice(0, 500), d ?? now());
        else if (type === "met") db.prepare("UPDATE person SET how_met = coalesce(how_met, ?) WHERE id = ?").run(text.slice(0, 300), p.id);
        else if (type === "goal") {
          if (!db.prepare("SELECT 1 FROM goal WHERE person_id = ? AND kind = 'relationship' AND status = 'open'").get(p.id)) db.prepare("INSERT INTO goal (kind, person_id, title, created_at) VALUES ('relationship', ?, ?, ?)").run(p.id, text.slice(0, 300), now());
        } else addInteraction(p.id, text, { source: src, kind: "handover", outcome: o.outcome ?? null, ts: d });
        out.filed++;
      }
    })();
    return out;
  }

  // ---- The guidance layer
  const inboxCount = () => (db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").get() as any).n as number;
  const openThreads = (pid: number) => (db.prepare("SELECT question FROM thread WHERE person_id = ? AND closed_at IS NULL ORDER BY id").all(pid) as any[]).map((t) => t.question as string);
  const relGoal = (pid: number) => db.prepare("SELECT * FROM goal WHERE kind = 'relationship' AND person_id = ? AND status = 'open'").get(pid) as any;
  const addDays = (n: number) => { const d = new Date(`${ctx.day()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  /** Everything being worked on, one row each: a relationship (keyed by person) or a scenario (keyed by goal). */
  function items() {
    const list = (db.prepare("SELECT * FROM goal WHERE status = 'open'").all() as any[]).map(goalView).filter((g) => g.kind === "scenario" || g.people.length).map((g) => {
      const rel = g.kind === "relationship";
      const cur = g.steps.find((s: any) => s.id === g.current_step);
      return {
        key: rel ? `p:${g.person_id}` : `g:${g.id}`, kind: g.kind as string, person_id: rel ? (g.person_id as number) : null, goal_id: g.id as number,
        name: rel ? (g.people[0].name as string) : (g.title as string), about: rel ? (g.title as string) : ((g.done_looks_like as string | null) ?? ""),
        stage: g.stage as string | null, next_action: g.next_action as string | null, next_due: g.next_due as string | null, days_quiet: g.days_quiet as number | null,
        threads: rel ? openThreads(g.person_id) : [], step: cur ? `Step ${g.step_number} of ${g.steps.length}: ${cur.title}` : null, people: g.people.map((p: any) => p.name as string),
      };
    });
    return list.sort((a, b) => (a.next_due ?? "9999").localeCompare(b.next_due ?? "9999") || (a.days_quiet ?? 9999) - (b.days_quiet ?? 9999));
  }
  type Item = ReturnType<typeof items>[number];

  /** Changes whenever anything the brief is built from changes, and each new day. */
  function basis() {
    const q = (sql: string) => JSON.stringify(db.prepare(sql).all());
    return createHash("sha256").update([ctx.day(), q("SELECT max(id) AS m, count(*) AS c FROM interaction"), q("SELECT max(id) AS m, count(*) AS c FROM fact"),
      q("SELECT id, closed_at FROM thread"), q("SELECT id, name FROM person"), q("SELECT id, title, done_looks_like, stage, next_action, next_due, status FROM goal"),
      q("SELECT id, done_at FROM step"), String(inboxCount())].join("|")).digest("hex");
  }

  /** Dated next moves due within a day: always on top, whatever the model says. */
  const dueNow = (list: Item[]) => list.filter((i) => i.next_action && i.next_due && i.next_due <= addDays(1)).map((i) => ({ what: i.next_action!, when: i.next_due, key: i.key }));

  /** The brief without a model: built from dates, silences and open questions. */
  function rulesBrief(list: Item[]) {
    const inbox = inboxCount();
    const due = dueNow(list);
    const noMove = list.filter((i) => !i.next_action);
    const quietOnes = list.filter((i) => i.kind === "relationship" && (i.days_quiet ?? 0) >= 21);
    const points = [
      ...noMove.slice(0, 2).map((i) => `${i.name} has no next step. Decide one, even a small one.`),
      ...quietOnes.slice(0, 2).map((i) => `${i.name} has been quiet ${i.days_quiet} days.`),
    ].slice(0, 3);
    const summary = !list.length ? "Nothing set up yet. Tell it about someone below and it'll start guiding."
      : due.length ? `${due.length} thing${due.length === 1 ? "" : "s"} due. Start with: ${due[0].what}.`
      : noMove.length ? `Nothing due. ${noMove.length} ${noMove.length === 1 ? "has" : "have"} no next step yet.` : "Nothing due right now.";
    return {
      summary, points,
      do_now: [...due, ...(inbox ? [{ what: `Sort ${inbox} handed-over note${inbox === 1 ? "" : "s"}`, when: null, key: "inbox" }] : [])],
      items: Object.fromEntries(list.map((i) => [i.key, {
        guidance: [...i.threads.slice(0, 2).map((t) => `Open: ${t}`), ...(i.kind === "relationship" && (i.days_quiet ?? 0) >= 21 ? [`Quiet for ${i.days_quiet} days.`] : []), ...(i.step ? [i.step] : [])].slice(0, 3),
        next: i.next_action ? `${i.next_action}${i.next_due ? ` (${i.next_due})` : ""}` : "Decide a next step",
      }])),
    };
  }

  /** Pull a stored brief into shape against what exists now, with anything due always first. */
  function shapeBrief(raw: any, list: Item[]) {
    const keys = new Set([...list.map((i) => i.key), "inbox"]);
    const due = dueNow(list);
    const model = (Array.isArray(raw.do_now) ? raw.do_now : []).filter((d: any) => d?.what && keys.has(d.key) && !due.some((x) => x.key === d.key));
    const named = (key: string) => (key === "inbox" ? null : list.find((i) => i.key === key));
    return {
      summary: clip(raw.summary, 400), points: (Array.isArray(raw.points) ? raw.points : []).slice(0, 3).map((p: unknown) => clip(p, 300)).filter(Boolean),
      do_now: [...due, ...model].slice(0, 4).map((d: any) => {
        const it = named(d.key);
        return { what: clip(d.what, 300), when: d.when ? clip(d.when, 40) : null, key: d.key, who: it?.name ?? null, goal_id: it?.goal_id ?? null, is_next: Boolean(it && it.next_action === d.what) };
      }),
      items: Object.fromEntries(Object.entries(raw.items ?? {}).filter(([k]) => keys.has(k))),
    };
  }

  function material(list: Item[]) {
    const lines = list.slice(0, 30).map((i) => {
      const notes = i.kind === "relationship"
        ? (db.prepare("SELECT ts, text, outcome FROM interaction WHERE person_id = ? ORDER BY ts DESC, id DESC LIMIT 3").all(i.person_id) as any[])
        : (db.prepare("SELECT i.ts, i.text, i.outcome, p.name FROM interaction i JOIN person p ON p.id = i.person_id WHERE i.goal_id = ? ORDER BY i.ts DESC, i.id DESC LIMIT 3").all(i.goal_id) as any[]);
      const facts = i.person_id ? (db.prepare("SELECT label, value FROM fact WHERE person_id = ? ORDER BY id DESC LIMIT 6").all(i.person_id) as any[]) : [];
      return [
        `[${i.key}] ${i.kind === "relationship" ? `${i.name}, building toward: ${i.about}` : `Scenario: ${i.name}${i.about ? `. Done looks like: ${i.about}` : ""}. With: ${i.people.join(", ") || "no one named"}`}`,
        i.stage ? `Where it is: ${i.stage}` : "", i.step ?? "",
        `Next move: ${i.next_action ? `${i.next_action}${i.next_due ? ` (due ${i.next_due})` : ""}` : "none set"}`,
        i.kind === "relationship" ? `Last contact: ${i.days_quiet === null ? "nothing recorded" : `${i.days_quiet} days ago`}` : "",
        i.threads.length ? `Open questions: ${i.threads.join("; ")}` : "",
        facts.length ? `Details: ${facts.map((f) => `${f.label}: ${f.value}`).join("; ")}` : "",
        notes.length ? `Recent notes, newest first:\n${notes.map((n) => `- ${n.ts.slice(0, 10)}${n.outcome ? ` [${n.outcome}]` : ""}${n.name ? ` ${n.name}:` : ""} ${clip(n.text, 400)}`).join("\n")}` : "No notes yet.",
      ].filter(Boolean).join("\n");
    });
    const inbox = inboxCount();
    return [`Today is ${ctx.day()}.`, inbox ? `Unsorted notes waiting to be filed: ${inbox} (key "inbox").` : "", ...lines].filter(Boolean).join("\n\n");
  }

  let building: Promise<void> | null = null;
  /** Ask People's model for a fresh brief and keep it. Only one runs at a time. */
  function buildBrief(): Promise<void> {
    const cfg = ctx.modelFor("people_llm");
    if (!cfg) return Promise.resolve();
    if (building) return building;
    building = (async () => {
      const list = items();
      const b = basis();
      if (!list.length) { db.prepare("INSERT INTO brief (ts, basis, model, body) VALUES (?, ?, 'rules', ?)").run(now(), b, JSON.stringify(rulesBrief(list))); return; }
      const raw: any = extractJson(await chat(cfg, [{ role: "system", content: BRIEF_RULES }, { role: "user", content: material(list) }], 120_000));
      if (!raw || typeof raw.summary !== "string") throw new Error("it answered in the wrong shape");
      const known = new Set(list.map((i) => i.key));
      const byKey: Record<string, { guidance: string[]; next: string }> = {};
      for (const it of Array.isArray(raw.items) ? raw.items : []) {
        if (!known.has(it?.key)) continue;
        byKey[it.key] = { guidance: (Array.isArray(it.guidance) ? it.guidance : []).slice(0, 3).map((g: unknown) => clip(g, 300)).filter(Boolean), next: clip(it.next, 300) };
      }
      const body = { summary: raw.summary, points: raw.points, do_now: raw.do_now, items: byKey };
      db.prepare("INSERT INTO brief (ts, basis, model, body) VALUES (?, ?, ?, ?)").run(now(), b, cfg.model, JSON.stringify(body));
      db.prepare("DELETE FROM brief WHERE id NOT IN (SELECT id FROM brief ORDER BY id DESC LIMIT 20)").run();
    })().finally(() => { building = null; });
    return building;
  }

  /** The brief as it stands: the model's latest if there is one, otherwise the rules. */
  function currentBrief() {
    const list = items();
    const hasModel = Boolean(ctx.modelFor("people_llm"));
    const latest = hasModel ? (db.prepare("SELECT * FROM brief ORDER BY id DESC LIMIT 1").get() as any) : null;
    const raw = latest ? JSON.parse(latest.body) : rulesBrief(list);
    return { list, brief: { ...shapeBrief(raw, list), ts: latest?.ts ?? null, by: latest ? (latest.model === "rules" ? "rules" : "model") : "rules", building: Boolean(building) }, stale: hasModel && (!latest || latest.basis !== basis()) };
  }

  // ---- Home
  app.get("/api/people/home", (c) => {
    const { list, brief, stale: briefStale } = currentBrief();
    const goals = (db.prepare("SELECT * FROM goal WHERE status = 'open' ORDER BY next_due IS NULL, next_due, id").all() as any[]).map(goalView);
    const stale = (db.prepare("SELECT * FROM person").all() as any[]).map((p) => ({ id: p.id, name: p.name, days: daysSince(lastSeen(p.id)) })).filter((p) => p.days !== null && p.days >= 21);
    const next = goals.find((g) => g.next_action && g.next_due) ?? null;
    return c.json({
      next: next && { action: next.next_action, due: next.next_due, for: next.kind === "relationship" ? next.people[0]?.name : next.title, goal_id: next.id, kind: next.kind, person_id: next.person_id },
      relationships: goals.filter((g) => g.kind === "relationship"),
      scenarios: goals.filter((g) => g.kind === "scenario"),
      people: db.prepare("SELECT id, name FROM person ORDER BY name").all(),
      inbox: (db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").get() as any).n,
      // People who exist (usually from a hand-over) but aren't in a relationship goal or a scenario yet.
      unplaced: db.prepare(`SELECT p.id, p.name, p.imported, (SELECT count(*) FROM interaction i WHERE i.person_id = p.id) AS notes, (SELECT count(*) FROM fact f WHERE f.person_id = p.id) AS facts
        FROM person p WHERE NOT EXISTS (SELECT 1 FROM goal g WHERE g.person_id = p.id AND g.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM goal_people gp JOIN goal g ON g.id = gp.goal_id WHERE gp.person_id = p.id AND g.status = 'open') ORDER BY notes DESC, p.name`).all(),
      stale, has_model: Boolean(ctx.modelFor("people_llm")), outcomes: OUTCOMES,
      items: list, brief, brief_stale: briefStale,
      chat: (db.prepare("SELECT * FROM chat ORDER BY id DESC LIMIT 2").all() as any[]).reverse(),
      linked: Boolean(ctx.secret.get("people_token")),
    });
  });

  app.post("/api/people/brief", async (c) => {
    if (!ctx.modelFor("people_llm")) return bad(c, "Set a model for People in Settings to get guidance written for you.");
    try { await buildBrief(); } catch (e) { return bad(c, `People's model didn't help: ${(e as Error).message}.`, 502); }
    return c.json({ ok: true });
  });

  // Done with a next step: logged as a note, and cleared if it was the one set.
  app.post("/api/people/goals/:id/did", async (c) => {
    const g = goal(Number(c.req.param("id")));
    if (!g) return bad(c, "No such goal.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const what = clip(b.what, 300) || g.next_action;
    if (!what) return bad(c, "What did you do?");
    const pid = g.kind === "relationship" ? g.person_id : (db.prepare("SELECT person_id FROM goal_people WHERE goal_id = ? LIMIT 1").get(g.id) as any)?.person_id;
    if (pid) addInteraction(pid, `Done: ${what}`, { kind: "done", goal_id: g.kind === "scenario" ? g.id : null });
    if (g.next_action && (!b.what || g.next_action === b.what)) {
      db.prepare("UPDATE goal SET next_action = NULL, next_due = NULL WHERE id = ?").run(g.id);
      syncTask(goal(g.id));
    }
    return c.json({ ok: true });
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

  app.patch("/api/people/persons/:id", async (c) => {
    const p = person(Number(c.req.param("id")));
    if (!p) return bad(c, "No such person.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (typeof b.name === "string" && b.name.trim()) {
      const other = byName(b.name);
      if (other && other.id !== p.id) return bad(c, "There's already someone with that name. Merge them instead.", 409);
      db.prepare("UPDATE person SET name = ? WHERE id = ?").run(b.name.trim().slice(0, 80), p.id);
    }
    if ("how_met" in b) db.prepare("UPDATE person SET how_met = ? WHERE id = ?").run(typeof b.how_met === "string" && b.how_met.trim() ? b.how_met.trim().slice(0, 300) : null, p.id);
    return c.json(person(p.id));
  });

  // Two entries that are the same person: everything from this one moves onto the other.
  app.post("/api/people/persons/:id/merge", async (c) => {
    const from = person(Number(c.req.param("id")));
    const into = person(Number(((await c.req.json().catch(() => ({}))) as any).into));
    if (!from || !into || from.id === into.id) return bad(c, "Pick the person to merge into.");
    db.transaction(() => {
      for (const t of ["interaction", "thread", "fact", "reading"]) db.prepare(`UPDATE ${t} SET person_id = ? WHERE person_id = ?`).run(into.id, from.id);
      db.prepare("INSERT OR IGNORE INTO goal_people (goal_id, person_id) SELECT goal_id, ? FROM goal_people WHERE person_id = ?").run(into.id, from.id);
      db.prepare("DELETE FROM goal_people WHERE person_id = ?").run(from.id);
      const has = db.prepare("SELECT 1 FROM goal WHERE person_id = ? AND kind = 'relationship' AND status = 'open'").get(into.id);
      for (const g of db.prepare("SELECT * FROM goal WHERE person_id = ?").all(from.id) as any[]) {
        if (has && g.kind === "relationship" && g.status === "open") { db.prepare("UPDATE goal SET person_id = ?, status = 'dropped' WHERE id = ?").run(into.id, g.id); syncTask({ ...g, status: "dropped" }); }
        else db.prepare("UPDATE goal SET person_id = ? WHERE id = ?").run(into.id, g.id);
      }
      if (!into.how_met && from.how_met) db.prepare("UPDATE person SET how_met = ? WHERE id = ?").run(from.how_met, into.id);
      db.prepare("DELETE FROM person WHERE id = ?").run(from.id);
    })();
    return c.json(person(into.id));
  });

  // Remove someone and everything recorded about them. For hand-over mistakes; it can't be undone.
  app.delete("/api/people/persons/:id", (c) => {
    const p = person(Number(c.req.param("id")));
    if (!p) return bad(c, "No such person.", 404);
    db.transaction(() => {
      for (const g of db.prepare("SELECT * FROM goal WHERE person_id = ?").all(p.id) as any[]) { syncTask({ ...g, status: "dropped" }); db.prepare("DELETE FROM step WHERE goal_id = ?").run(g.id); }
      for (const t of ["interaction", "thread", "fact", "reading", "goal", "goal_people"]) db.prepare(`DELETE FROM ${t} WHERE person_id = ?`).run(p.id);
      db.prepare("DELETE FROM person WHERE id = ?").run(p.id);
    })();
    return c.json({ removed: true });
  });

  app.get("/api/people/persons/:id", (c) => {
    const p = person(Number(c.req.param("id")));
    if (!p) return bad(c, "No such person.", 404);
    const log = (db.prepare("SELECT * FROM interaction WHERE person_id = ? ORDER BY ts DESC, id DESC").all(p.id) as any[]).map((i) => ({ ...i, quotes: JSON.parse(i.quotes) }));
    const g = db.prepare("SELECT * FROM goal WHERE kind = 'relationship' AND person_id = ? AND status = 'open'").get(p.id) as any;
    const reading = db.prepare("SELECT * FROM reading WHERE person_id = ? ORDER BY id DESC LIMIT 1").get(p.id) as any;
    return c.json({ others: db.prepare("SELECT id, name FROM person WHERE id != ? ORDER BY name").all(p.id), 
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
    const log = (db.prepare("SELECT i.*, p.name AS person_name FROM interaction i JOIN person p ON p.id = i.person_id WHERE i.goal_id = ? ORDER BY i.ts DESC, i.id DESC").all(g.id) as any[]).map((i) => ({ ...i, quotes: JSON.parse(i.quotes) }));
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
    if (!fileId && b.inbox_id) fileId = (db.prepare("SELECT file_id FROM inbox WHERE id = ?").get(Number(b.inbox_id)) as any)?.file_id ?? null;
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
    const auth = c.req.header("authorization");
    if (!tokenIs(auth, ctx.secret.get("relay_token")) && !tokenIs(auth, ctx.secret.get("people_token"))) return bad(c, "Wrong or missing relay token.", 401);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const items = Array.isArray(b.items) ? b.items : [b.text ?? b];
    const r = handOver(items.slice(0, 2000), String(b.source ?? "hermes"));
    if (!r.received) return bad(c, "Send the notes as \"text\" or as a list in \"items\".");
    return c.json(r); // counts only: nothing about People is ever sent back
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

  // ---- Ask or add: one box that answers questions and files context. The app, and Hermes through the People link.
  app.get("/api/people/chat", (c) => c.json({ messages: (db.prepare("SELECT * FROM chat ORDER BY id DESC LIMIT 40").all() as any[]).reverse() }));

  /** Turn attachments into text the model can read. Images are kept as files: People's model can't see them. */
  async function readAttachments(files: File[]) {
    const texts: string[] = [], images: number[] = [], names: string[] = [], pictures: string[] = [];
    let budget = 30_000;
    for (const f of files.slice(0, 6)) {
      names.push(f.name || "file");
      const name = (f.name || "").toLowerCase();
      if (f.type.startsWith("image/")) {
        images.push((await saveFile(ctx, f, "people")).id);
        if (pictures.length < 4 && f.size <= 8 * 1024 * 1024) pictures.push(`data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`);
        continue;
      }
      let text = "";
      if (f.type === "application/pdf" || name.endsWith(".pdf")) text = (await pdfLines(new Uint8Array(await f.arrayBuffer()))).map((l) => l.cells.map((x) => x.text).join(" ")).join("\n");
      else if (f.type.startsWith("text/") || /\.(md|markdown|txt|csv|json)$/.test(name)) text = await f.text();
      else { images.push((await saveFile(ctx, f, "people")).id); continue; }
      text = text.trim().slice(0, Math.max(0, budget));
      budget -= text.length;
      if (text) texts.push(`Attached file "${f.name}":\n${text}`);
    }
    return { texts, images, names, pictures };
  }

  /** The record for anyone named in what was said, so answers rest on what's known. */
  function recordFor(text: string) {
    const t = ` ${text.toLowerCase()} `;
    const named = (db.prepare("SELECT * FROM person").all() as any[]).filter((p) => {
      const full = p.name.toLowerCase(), first = full.split(/\s+/)[0];
      return t.includes(full) || (first.length >= 3 && new RegExp(`[^a-z]${first.replace(/[^a-z]/g, "")}[^a-z]`).test(t));
    }).slice(0, 4);
    return named.map((p) => {
      const g = relGoal(p.id);
      const notes = db.prepare("SELECT ts, text, outcome FROM interaction WHERE person_id = ? ORDER BY ts DESC, id DESC LIMIT 6").all(p.id) as any[];
      const facts = db.prepare("SELECT label, value FROM fact WHERE person_id = ? ORDER BY id DESC LIMIT 10").all(p.id) as any[];
      return [`About ${p.name}${p.how_met ? ` (met: ${p.how_met})` : ""}:`, g ? `Building toward: ${g.title}${g.stage ? `. Where it is: ${g.stage}` : ""}. Next move: ${g.next_action ?? "none"}${g.next_due ? ` (${g.next_due})` : ""}` : "No goal set.",
        openThreads(p.id).length ? `Open questions: ${openThreads(p.id).join("; ")}` : "", facts.length ? `Details: ${facts.map((f) => `${f.label}: ${f.value}`).join("; ")}` : "",
        notes.length ? `Notes, newest first:\n${notes.map((n) => `- ${n.ts.slice(0, 10)}${n.outcome ? ` [${n.outcome}]` : ""}: ${clip(n.text, 600)}`).join("\n")}` : ""].filter(Boolean).join("\n");
    });
  }

  function setNext(g: any, what: string, when: unknown) {
    const due = DATE.test(String(when)) ? String(when) : null;
    db.prepare("UPDATE goal SET next_action = ?, next_due = ? WHERE id = ?").run(due ? what.slice(0, 300) : `${what.slice(0, 250)} (${clip(when, 40) || "no date set"})`, due, g.id);
    syncTask(goal(g.id));
  }

  async function ask(text: string, files: File[], source: string): Promise<{ reply: string; did: string[] }> {
    const att = await readAttachments(files);
    const said = [text, att.names.length ? `📎 ${att.names.join(", ")}` : ""].filter(Boolean).join("\n");
    const cfg = ctx.modelFor("people_llm");
    const toPile = (why: string) => {
      db.prepare("INSERT INTO inbox (ts, source, text, file_id) VALUES (?, ?, ?, ?)").run(now(), source.slice(0, 40), [text, ...att.texts].filter(Boolean).join("\n\n").slice(0, 20_000) || `(${att.names.join(", ")})`, att.images[0] ?? null);
      return { reply: why, did: ["Saved to Handed over"] };
    };
    if (!cfg) return toPile("Saved to Handed over. Set a model for People in Settings and it will answer and file things for you.");
    const known = (db.prepare("SELECT name FROM person ORDER BY name").all() as any[]).map((p) => p.name);
    const history = (db.prepare("SELECT role, text FROM chat ORDER BY id DESC LIMIT 8").all() as any[]).reverse();
    const latest = db.prepare("SELECT body FROM brief ORDER BY id DESC LIMIT 1").get() as any;
    const overview = latest ? JSON.parse(latest.body) : null;
    const chunks = retrieve(db.prepare("SELECT id, doc, heading, body FROM library").all() as any[], [text, ...att.texts].join(" ").slice(0, 4000), 3);
    const context = [
      `Known people: ${JSON.stringify(known)}`, `Today is ${ctx.day()}.`,
      overview?.summary ? `Current overview: ${overview.summary}${Array.isArray(overview.points) && overview.points.length ? ` Points: ${overview.points.join(" / ")}` : ""}` : "",
      ...recordFor([text, ...att.texts].join(" ")),
      chunks.length ? `Library passages:\n${chunks.map((x) => `[${x.id}] ${x.heading}: ${x.body.slice(0, 1000)}`).join("\n\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const base = [text || "(no message, just the attachments)", ...att.texts].join("\n\n");
    const blind = att.images.length ? `\n\n(${att.images.length} image${att.images.length === 1 ? "" : "s"} attached that you can't see. If what's in it matters, ask him what it shows.)` : "";
    const send = (content: ChatMessage["content"]) => chat(cfg, [{ role: "system", content: `${ASK_RULES}\n\n${context}` }, ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.text })), { role: "user", content }], 180_000);
    let parsed: any, sent = false;
    try {
      // Screenshots go to the model as images. If it (or whatever sits in front of it) won't take them, ask again without.
      if (att.pictures.length) {
        try { parsed = extractJson(await send([{ type: "text", text: base }, ...att.pictures.map((url) => ({ type: "image_url" as const, image_url: { url } }))])); sent = true; }
        catch { parsed = undefined; }
      }
      if (parsed === undefined) parsed = extractJson(await send(base + blind));
    } catch (e) {
      return toPile(`People's model didn't answer (${(e as Error).message}), so this went to Handed over to file later.`);
    }
    const did: string[] = [];
    let image: number | null = att.images[0] ?? null;
    for (const a of Array.isArray(parsed?.actions) ? parsed.actions.slice(0, 12) : []) {
      if (a?.type === "new_person" && typeof a.name === "string" && a.name.trim() && !byName(a.name)) {
        db.prepare("INSERT INTO person (name, how_met, created_at) VALUES (?, ?, ?)").run(a.name.trim().slice(0, 80), typeof a.how_met === "string" ? a.how_met.slice(0, 200) : null, now());
        did.push(`Added ${a.name.trim()}`);
        continue;
      }
      const p = typeof a?.person === "string" ? byName(a.person) : null;
      if (!p) continue; // never file under a name that isn't already known
      if (a.type === "note" && typeof a.text === "string" && a.text.trim()) {
        addInteraction(p.id, a.text, { kind: image ? "screenshot" : "chat", outcome: a.outcome, source: source === "app" ? "app" : source, file_id: image });
        image = null;
        did.push(`Note filed under ${p.name}`);
      } else if (a.type === "goal" && typeof a.text === "string" && a.text.trim() && !relGoal(p.id)) {
        db.prepare("INSERT INTO goal (kind, person_id, title, created_at) VALUES ('relationship', ?, ?, ?)").run(p.id, a.text.trim().slice(0, 300), now());
        did.push(`Now building toward something with ${p.name}`);
      } else if (a.type === "thread" && typeof a.question === "string" && a.question.trim()) {
        db.prepare("INSERT INTO thread (person_id, question, opened_at) VALUES (?, ?, ?)").run(p.id, a.question.trim().slice(0, 300), now());
        did.push(`Open question added for ${p.name}`);
      } else if (a.type === "fact" && a.label && a.value) {
        db.prepare("INSERT INTO fact (person_id, label, value, grade, created_at) VALUES (?, ?, ?, ?, ?)").run(p.id, String(a.label).slice(0, 40), String(a.value).slice(0, 300), a.guess ? "O:inf" : "O:ben", now());
        did.push(`${a.guess ? "Guess" : "Detail"} added for ${p.name}`);
      } else if (a.type === "next" && typeof a.what === "string" && a.what.trim() && relGoal(p.id)) {
        setNext(relGoal(p.id), a.what.trim(), a.when);
        did.push(`Next step set for ${p.name}`);
      }
    }
    if (att.images.length && (!sent || parsed?.saw_images === false)) did.push(sent ? "The model couldn't read the image" : "The model can't take images, so it didn't see it");
    if (image !== null) { db.prepare("INSERT INTO inbox (ts, source, text, file_id) VALUES (?, ?, ?, ?)").run(now(), source.slice(0, 40), text || "(image)", image); did.push("Image saved to Handed over"); }
    const reply = typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : did.length ? "Filed." : "I didn't file anything from that.";
    db.prepare("INSERT INTO chat (ts, role, text) VALUES (?, 'user', ?)").run(now(), said || "(attachments)");
    db.prepare("INSERT INTO chat (ts, role, text) VALUES (?, 'assistant', ?)").run(now(), reply);
    return { reply, did };
  }

  app.post("/api/people/ask", async (c) => {
    let text = "", files: File[] = [];
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.formData();
      text = String(form.get("text") ?? "");
      files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    } else text = String(((await c.req.json().catch(() => ({}))) as any).text ?? "");
    text = text.trim().slice(0, 20_000);
    if (!text && !files.length) return bad(c, "Say, type or attach something first.");
    try { return c.json(await ask(text, files, "app")); } catch (e) { return bad(c, (e as Error).message); }
  });

  // ---- A deeper guide for one person or scenario, on request
  function target(key: string) {
    const [k, n] = [key.slice(0, 1), Number(key.slice(2))];
    if (k === "p") { const p = person(n); return p ? { key, p, g: relGoal(p.id) } : null; }
    const g = k === "g" ? goal(n) : null;
    return g ? { key, p: null, g } : null;
  }
  const guideView = (r: any) => (r ? { id: r.id, ts: r.ts, model: r.model, ...JSON.parse(r.body) } : null);
  app.get("/api/people/guide", (c) => c.json({ guide: guideView(db.prepare("SELECT * FROM guide WHERE target = ? ORDER BY id DESC LIMIT 1").get(c.req.query("key") ?? "")) }));
  app.post("/api/people/guide", async (c) => {
    const cfg = ctx.modelFor("people_llm");
    if (!cfg) return bad(c, "Set a model for People in Settings to get deeper guidance.");
    const t = target(String(((await c.req.json().catch(() => ({}))) as any).key ?? ""));
    if (!t) return bad(c, "Pick a person or a scenario.", 404);
    const view = t.g ? goalView(t.g) : null;
    const notes = (t.p
      ? db.prepare("SELECT ts, text, outcome, NULL AS name FROM interaction WHERE person_id = ? ORDER BY ts DESC, id DESC LIMIT 12").all(t.p.id)
      : db.prepare("SELECT i.ts, i.text, i.outcome, p.name FROM interaction i JOIN person p ON p.id = i.person_id WHERE i.goal_id = ? ORDER BY i.ts DESC, i.id DESC LIMIT 12").all(t.g.id)) as any[];
    const facts = t.p ? (db.prepare("SELECT label, value FROM fact WHERE person_id = ?").all(t.p.id) as any[]) : [];
    const chunks = retrieve(db.prepare("SELECT id, doc, heading, body FROM library").all() as any[], `${notes.map((n) => n.text).join(" ")} ${t.g?.title ?? ""}`);
    const material = [
      t.p ? `Person: ${t.p.name}${t.p.how_met ? ` (met: ${t.p.how_met})` : ""}. Last contact: ${quietText(daysSince(lastSeen(t.p.id)))}.` : `Scenario: ${t.g.title}${t.g.done_looks_like ? `. Done looks like: ${t.g.done_looks_like}` : ""}. With: ${view!.people.map((x: any) => x.name).join(", ") || "no one named"}.`,
      t.g ? `${t.g.kind === "relationship" ? "Building toward" : "Outcome"}: ${t.g.title}${t.g.stage ? `. Where it is: ${t.g.stage}` : ""}. Next move: ${t.g.next_action ?? "none"}${t.g.next_due ? ` (${t.g.next_due})` : ""}` : "No goal set yet.",
      view?.steps.length ? `Steps: ${view.steps.map((s: any, i: number) => `${i + 1}. ${s.title}${s.done_at ? " (done)" : s.id === view.current_step ? " (current)" : ""}`).join("; ")}` : "",
      t.p && openThreads(t.p.id).length ? `Open questions: ${openThreads(t.p.id).join("; ")}` : "",
      facts.length ? `Details: ${facts.map((f) => `${f.label}: ${f.value}`).join("; ")}` : "",
      notes.length ? `Notes, newest first:\n${notes.map((n) => `- ${n.ts.slice(0, 10)}${n.outcome ? ` [${n.outcome}]` : ""}${n.name ? ` ${n.name}:` : ""} ${clip(n.text, 700)}`).join("\n")}` : "No notes yet.",
      chunks.length ? `Library passages:\n${chunks.map((x) => `[${x.id}] ${x.heading}: ${x.body.slice(0, 1200)}`).join("\n\n")}` : "Library passages: none relevant. Set \"words\" to null.",
      `Today is ${ctx.day()}.`,
    ].filter(Boolean).join("\n\n");
    let body: any;
    try { body = extractJson(await chat(cfg, [{ role: "system", content: GUIDE_RULES }, { role: "user", content: material }], 120_000)); } catch (e) { return bad(c, `People's model didn't help: ${(e as Error).message}.`, 502); }
    if (!body || !Array.isArray(body.points)) return bad(c, "People's model answered in the wrong shape. Try again.", 502);
    const shaped = {
      read: clip(body.read, 500), points: body.points.slice(0, 4).map((p: unknown) => clip(p, 300)).filter(Boolean), watch_for: clip(body.watch_for, 300),
      next: body.next?.what ? { what: clip(body.next.what, 300), when: body.next.when ? clip(body.next.when, 40) : null } : null,
      words: body.words && chunks.some((x) => x.id === Number(body.words.source)) ? { text: clip(body.words.text, 600), source: Number(body.words.source) } : null, // a citation must point at a passage that was sent
    };
    const r = db.prepare("INSERT INTO guide (ts, target, model, body) VALUES (?, ?, ?, ?)").run(now(), t.key, cfg.model, JSON.stringify(shaped));
    return c.json({ guide: guideView(db.prepare("SELECT * FROM guide WHERE id = ?").get(Number(r.lastInsertRowid))) });
  });
  app.post("/api/people/guide/:id/use", (c) => {
    const r = guideView(db.prepare("SELECT * FROM guide WHERE id = ?").get(Number(c.req.param("id"))));
    if (!r?.next) return bad(c, "That guide has no next step.", 404);
    const t = target(String((db.prepare("SELECT target FROM guide WHERE id = ?").get(r.id) as any).target));
    if (!t?.g) return bad(c, "Say what you want this to be first, then set a next step.");
    setNext(t.g, r.next.what, r.next.when);
    return c.json({ ok: true });
  });

  // ---- The People link: lets Hermes ask and add from Telegram. Its own token, made only from inside People.
  app.get("/api/people/link-token", (c) => c.json({ set: Boolean(ctx.secret.get("people_token")) }));
  app.post("/api/people/link-token", (c) => { const token = randomBytes(24).toString("hex"); ctx.secret.set("people_token", token); return c.json({ token }); });
  app.delete("/api/people/link-token", (c) => { ctx.secret.set("people_token", null); return c.json({ ok: true }); });
  const linked = (c: any) => tokenIs(c.req.header("authorization"), ctx.secret.get("people_token"));
  app.post("/api/people-ask", async (c) => {
    if (!linked(c)) return bad(c, "Wrong or missing People token.", 401);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const text = String(b.text ?? "").trim().slice(0, 20_000);
    // Images as {"data": base64 or a data: URL, "type": "image/png", "name"?}, up to 4.
    const files = (Array.isArray(b.images) ? b.images : []).slice(0, 4).flatMap((im: any, n: number) => {
      const m = typeof im?.data === "string" ? im.data.match(/^(?:data:(image\/[\w.+-]+);base64,)?([A-Za-z0-9+/=\s]+)$/) : null;
      const type = m?.[1] ?? (typeof im?.type === "string" && im.type.startsWith("image/") ? im.type : "image/jpeg");
      const bytes = m ? Buffer.from(m[2], "base64") : null;
      return bytes?.length && bytes.length <= 8 * 1024 * 1024 ? [new File([bytes], clip(im.name, 80) || `telegram-${n + 1}.${type.split("/")[1]}`, { type })] : [];
    });
    if (!text && !files.length) return bad(c, "Send what he said as \"text\", and any screenshots as \"images\".");
    return c.json(await ask(text, files, clip(b.source ?? "telegram", 40) || "telegram"));
  });
  app.get("/api/people-brief", async (c) => {
    if (!linked(c)) return bad(c, "Wrong or missing People token.", 401);
    let cur = currentBrief();
    if (cur.stale) { try { await buildBrief(); cur = currentBrief(); } catch { /* fall back to the last one */ } }
    const { brief } = cur;
    const text = [brief.summary, brief.do_now.length ? `Do now:\n${brief.do_now.map((d) => `- ${d.what}${d.who ? ` (${d.who})` : ""}${d.when ? `, ${d.when}` : ""}`).join("\n")}` : "", brief.points.length ? `Guidance:\n${brief.points.map((p: string) => `- ${p}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    return c.json({ text, summary: brief.summary, do_now: brief.do_now.map(({ what, who, when }) => ({ what, who, when })), points: brief.points, written: brief.ts });
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
    const recent = (db.prepare(`SELECT * FROM interaction WHERE ${where[0]} ORDER BY ts DESC, id DESC LIMIT 2`).all(where[1]) as any[]).reverse();
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
  return { drop: (text: string, source: string) => { handOver([text], source); } };
}
