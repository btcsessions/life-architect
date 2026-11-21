// Work: the tutorial pipeline and Bitcast prep. The app keeps the list, order, notes, links and stage of each
// tutorial; the heavy lifting (Bitcast prep, line edit, YouTube prep) stays in Hermes's own skills, which the app
// triggers by sending Hermes the same words Ben would. Hermes's API takes text only and remembers nothing between
// calls, so the app keeps each conversation and resends it, and hands over files as a link Hermes can download.
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { Ctx } from "./app.ts";
import { chat } from "./file.ts";
import { saveFile, serve, deleteFile, type StoredFile } from "./files.ts";

export const STAGES = ["idea", "outline", "record", "line_edit", "youtube_prep", "live"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_NAMES: Record<Stage, string> = { idea: "Idea", outline: "Outline", record: "Record", line_edit: "Line edit", youtube_prep: "YouTube prep", live: "Live" };
type Msg = { role: "system" | "user" | "assistant"; content: string };

/** The address Hermes uses to reach this app from its own container on the same Umbrel. */
const selfUrl = () => (process.env.SELF_URL ?? "http://btcsessions-life-architect_web_1:4600").replace(/\/+$/, "");
const INTRO = /<<<INTRO\s*([\s\S]*?)\s*INTRO>>>/;

export function mountWork(app: Hono, ctx: Ctx) {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS tutorials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'idea', position REAL NOT NULL DEFAULT 0,
      notes TEXT, outline TEXT, outline_from TEXT, source TEXT NOT NULL DEFAULT 'you', video_id TEXT, folder TEXT,
      filed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tutorial_links (id INTEGER PRIMARY KEY AUTOINCREMENT, tutorial_id INTEGER NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tutorial_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tutorial_id INTEGER NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bitcast (
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, file_id INTEGER, file_token TEXT, takes TEXT NOT NULL DEFAULT '[]',
      report TEXT, filed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'working',
      messages TEXT NOT NULL, reply TEXT, created_at TEXT NOT NULL, done_at TEXT
    );
  `);
  db.prepare("UPDATE work_jobs SET status = 'failed', reply = 'This was interrupted by a restart. Run it again.' WHERE status = 'working'").run();
  const now = () => ctx.now().toISOString();
  const bad = (c: any, error: string, status = 400) => c.json({ error }, status);
  const log = (id: number, text: string) => db.prepare("INSERT INTO tutorial_log (tutorial_id, ts, text) VALUES (?, ?, ?)").run(id, now(), text.slice(0, 500));
  const tut = (id: number) => db.prepare("SELECT * FROM tutorials WHERE id = ?").get(id) as any;
  const byTitle = (title: string) => db.prepare("SELECT * FROM tutorials WHERE lower(title) = lower(?) ORDER BY filed_at IS NOT NULL, id DESC").get(title.trim()) as any;
  /** A spoken or typed name matched loosely: exact first, then the one open tutorial whose title contains it. */
  const find = (name: string) => {
    const exact = byTitle(name);
    if (exact) return exact;
    const q = name.trim().toLowerCase();
    const hits = (db.prepare("SELECT * FROM tutorials WHERE filed_at IS NULL").all() as any[]).filter((t) => t.title.toLowerCase().includes(q) || q.includes(t.title.toLowerCase()));
    return hits.length === 1 ? hits[0] : null;
  };
  const lastJob = (kind: string, ref: number) => db.prepare("SELECT id, kind, status, reply, created_at, done_at FROM work_jobs WHERE kind = ? AND ref = ? ORDER BY id DESC").get(kind, ref) as any;
  const brief = (t: any) => ({
    id: t.id, title: t.title, stage: t.stage as Stage, stage_number: STAGES.indexOf(t.stage) + 1, source: t.source, has_outline: Boolean(t.outline),
    links: (db.prepare("SELECT count(*) AS n FROM tutorial_links WHERE tutorial_id = ?").get(t.id) as any).n, has_notes: Boolean(t.notes), filed_at: t.filed_at,
    running: (db.prepare("SELECT kind FROM work_jobs WHERE ref = ? AND status = 'working' AND kind != 'bitcast'").get(t.id) as any)?.kind ?? null,
  });
  function addTutorial(title: string, o: { notes?: string; source?: string; stage?: Stage; links?: Array<{ label?: string; url?: string }> } = {}) {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 160);
    if (!clean) return null;
    const had = byTitle(clean);
    if (had) return { row: had, created: false };
    const last = (db.prepare("SELECT coalesce(max(position), 0) AS p FROM tutorials").get() as any).p;
    const id = Number(db.prepare("INSERT INTO tutorials (title, stage, position, notes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(clean, o.stage && STAGES.includes(o.stage) ? o.stage : "idea", last + 1, o.notes?.trim().slice(0, 8000) || null, (o.source ?? "you").slice(0, 40), now(), now()).lastInsertRowid);
    for (const l of o.links ?? []) if (typeof l?.url === "string" && /^https?:\/\//.test(l.url)) db.prepare("INSERT INTO tutorial_links (tutorial_id, label, url) VALUES (?, ?, ?)").run(id, String(l.label ?? l.url).slice(0, 120), l.url.slice(0, 1000));
    log(id, `Idea added${o.source && o.source !== "you" ? ` from ${o.source}` : ""}`);
    return { row: tut(id), created: true };
  }

  /** Send a conversation to Hermes in the background and keep what comes back. */
  function runJob(kind: string, ref: number, messages: Msg[], after?: (reply: string) => void) {
    const cfg = ctx.modelFor("llm");
    const id = Number(db.prepare("INSERT INTO work_jobs (kind, ref, messages, created_at) VALUES (?, ?, ?, ?)").run(kind, ref, JSON.stringify(messages), now()).lastInsertRowid);
    const finish = (status: string, reply: string) => db.prepare("UPDATE work_jobs SET status = ?, reply = ?, messages = ?, done_at = ? WHERE id = ?")
      .run(status, reply.slice(0, 40_000), JSON.stringify(status === "done" ? [...messages, { role: "assistant", content: reply }] : messages), now(), id);
    if (!cfg) { finish("failed", "No model is set in Settings, so Hermes can't be reached."); return id; }
    chat(cfg, messages, 20 * 60_000)
      .then((reply) => { finish("done", reply.trim() || "Done."); try { after?.(reply); } catch { /* the reply is kept either way */ } })
      .catch(() => finish("failed", "Hermes didn't answer. Check it's running, then try again."));
    return id;
  }
  const working = (kind: string, ref: number) => Boolean(db.prepare("SELECT 1 FROM work_jobs WHERE kind = ? AND ref = ? AND status = 'working'").get(kind, ref));

  // ---- Work home
  app.get("/api/work", (c) => {
    const open = db.prepare("SELECT * FROM tutorials WHERE filed_at IS NULL ORDER BY position, id").all() as any[];
    const ep = episode(false);
    return c.json({
      stages: STAGES.map((s) => ({ id: s, name: STAGE_NAMES[s] })),
      in_motion: open.filter((t) => t.stage !== "idea").sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage)).map(brief),
      up_next: open.filter((t) => t.stage === "idea").map(brief),
      bitcast: ep ? { day: ep.day, has_file: Boolean(ep.file_id), takes: JSON.parse(ep.takes).length, running: working("bitcast", ep.id) } : null,
      filed: (db.prepare("SELECT count(*) AS n FROM tutorials WHERE filed_at IS NOT NULL").get() as any).n,
      has_model: Boolean(ctx.modelFor("llm")),
    });
  });
  app.get("/api/work/filed", (c) => c.json({ tutorials: (db.prepare("SELECT * FROM tutorials WHERE filed_at IS NOT NULL ORDER BY filed_at DESC").all() as any[]).map(brief), episodes: db.prepare("SELECT id, day, filed_at FROM bitcast WHERE filed_at IS NOT NULL ORDER BY day DESC").all() }));

  // ---- Tutorials
  app.post("/api/work/tutorials", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    // One title, or a pasted list (one per line; bullets and numbering are stripped).
    const lines = typeof b.list === "string" ? b.list.split(/\r?\n/).map((l: string) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((l: string) => l.length > 1) : [String(b.title ?? "")];
    let added = 0, first: any = null;
    for (const line of lines.slice(0, 300)) { const r = addTutorial(line, { notes: lines.length === 1 ? b.notes : undefined, source: b.source }); if (r?.created) added++; first ??= r?.row; }
    if (!first) return bad(c, "Give the tutorial a title.");
    return c.json({ added, already_there: lines.length - added, tutorial: brief(first) });
  });
  app.get("/api/work/tutorials/:id", (c) => {
    const t = tut(Number(c.req.param("id")));
    if (!t) return bad(c, "No such tutorial.", 404);
    const i = STAGES.indexOf(t.stage);
    return c.json({
      ...brief(t), notes: t.notes, outline: t.outline, outline_from: t.outline_from, video_id: t.video_id, folder: t.folder,
      next_stage: i < STAGES.length - 1 ? { id: STAGES[i + 1], name: STAGE_NAMES[STAGES[i + 1]] } : null,
      stages: STAGES.map((s, n) => ({ id: s, name: STAGE_NAMES[s], state: n < i ? "done" : n === i ? "now" : "later" })),
      link_list: db.prepare("SELECT * FROM tutorial_links WHERE tutorial_id = ? ORDER BY id").all(t.id),
      log: db.prepare("SELECT ts, text FROM tutorial_log WHERE tutorial_id = ? ORDER BY id DESC LIMIT 30").all(t.id),
      jobs: { line_edit: lastJob("line_edit", t.id) ?? null, youtube_prep: lastJob("youtube_prep", t.id) ?? null },
      has_model: Boolean(ctx.modelFor("llm")),
    });
  });
  app.patch("/api/work/tutorials/:id", async (c) => {
    const t = tut(Number(c.req.param("id")));
    if (!t) return bad(c, "No such tutorial.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const set = (col: string, v: unknown) => db.prepare(`UPDATE tutorials SET ${col} = ?, updated_at = ? WHERE id = ?`).run(v, now(), t.id);
    if (typeof b.title === "string" && b.title.trim()) set("title", b.title.trim().slice(0, 160));
    if ("notes" in b) set("notes", typeof b.notes === "string" && b.notes.trim() ? b.notes.slice(0, 8000) : null);
    if ("video_id" in b) set("video_id", typeof b.video_id === "string" && b.video_id.trim() ? b.video_id.trim().slice(0, 40) : null);
    if ("folder" in b) set("folder", typeof b.folder === "string" && b.folder.trim() ? b.folder.trim().slice(0, 120) : null);
    if ("outline" in b) {
      const text = typeof b.outline === "string" && b.outline.trim() ? b.outline.slice(0, 60_000) : null;
      set("outline", text);
      set("outline_from", text ? String(b.outline_from ?? "you").slice(0, 60) : null);
      if (text) { log(t.id, "Outline saved"); if (t.stage === "idea") set("stage", "outline"); }
    }
    if (STAGES.includes(b.stage) && b.stage !== t.stage) { set("stage", b.stage); log(t.id, `Moved to ${STAGE_NAMES[b.stage as Stage]}`); }
    if (b.filed === true && !t.filed_at) { set("filed_at", now()); log(t.id, "Filed away"); }
    if (b.filed === false && t.filed_at) { set("filed_at", null); log(t.id, "Brought back from the files"); }
    return c.json(brief(tut(t.id)));
  });
  app.delete("/api/work/tutorials/:id", (c) => {
    const id = Number(c.req.param("id"));
    for (const table of ["tutorial_links", "tutorial_log"]) db.prepare(`DELETE FROM ${table} WHERE tutorial_id = ?`).run(id);
    return c.json({ removed: db.prepare("DELETE FROM tutorials WHERE id = ?").run(id).changes });
  });
  // The new order of the ideas list, top to bottom.
  app.post("/api/work/tutorials/order", async (c) => {
    const ids = ((await c.req.json().catch(() => ({}))) as any).ids;
    if (!Array.isArray(ids)) return bad(c, "Send the ids in their new order.");
    db.transaction(() => ids.forEach((id: unknown, i: number) => db.prepare("UPDATE tutorials SET position = ? WHERE id = ?").run(i + 1, Number(id))))();
    return c.json({ ok: true });
  });
  app.post("/api/work/tutorials/:id/links", async (c) => {
    const t = tut(Number(c.req.param("id")));
    if (!t) return bad(c, "No such tutorial.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const url = String(b.url ?? "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) return bad(c, "Links start with http:// or https://");
    db.prepare("INSERT INTO tutorial_links (tutorial_id, label, url) VALUES (?, ?, ?)").run(t.id, String(b.label ?? "").trim().slice(0, 120) || new URL(url).hostname, url.slice(0, 1000));
    return c.json({ ok: true });
  });
  app.delete("/api/work/links/:id", (c) => c.json({ removed: db.prepare("DELETE FROM tutorial_links WHERE id = ?").run(Number(c.req.param("id"))).changes }));

  // Hand the tutorial's next job to one of Hermes's skills.
  app.post("/api/work/tutorials/:id/run", async (c) => {
    const t = tut(Number(c.req.param("id")));
    if (!t) return bad(c, "No such tutorial.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const kind = b.skill === "line_edit" || b.skill === "youtube_prep" ? (b.skill as "line_edit" | "youtube_prep") : null;
    if (!kind) return bad(c, "Pick line edit or YouTube prep.");
    if (!ctx.modelFor("llm")) return bad(c, "Set the deck model (Hermes) in Settings first.");
    if (working(kind, t.id)) return bad(c, "That's already running.", 409);
    const say = String(b.say ?? "").trim().slice(0, 4000);
    const prev = lastJob(kind, t.id);
    // A follow-up continues the same conversation, resent in full because Hermes's API keeps no memory.
    const history: Msg[] = say && prev?.status === "done" ? JSON.parse((db.prepare("SELECT messages FROM work_jobs WHERE id = ?").get(prev.id) as any).messages) : [];
    let first: string;
    if (kind === "line_edit") {
      first = `Line edit ${t.folder || t.title}.${t.outline ? "" : " There is no outline saved in Life Architect for this one."} Send progress, questions and the finished link to me on Telegram as usual. When it has finished, also tell Life Architect with the relay call POST /api/relay/tutorial-update {"title": ${JSON.stringify(t.title)}, "stage": "youtube_prep", "note": "<one line>", "link": "<the Drive folder>"}. Reply here only with whether it started.`;
    } else {
      first = `YouTube prep for "${t.title}".${t.video_id ? ` The private upload's video ID is ${t.video_id}.` : ""}${say && !history.length ? ` ${say}` : ""}`;
    }
    const messages: Msg[] = history.length ? [...history, { role: "user", content: say }] : [{ role: "user", content: first }];
    if (STAGES.indexOf(t.stage) < STAGES.indexOf(kind)) db.prepare("UPDATE tutorials SET stage = ?, updated_at = ? WHERE id = ?").run(kind, now(), t.id);
    log(t.id, history.length ? `Replied to Hermes about the ${STAGE_NAMES[kind].toLowerCase()}` : `${STAGE_NAMES[kind]} handed to Hermes`);
    runJob(kind, t.id, messages, () => log(t.id, kind === "line_edit" ? "Hermes answered about the line edit" : "YouTube prep came back from Hermes"));
    return c.json({ started: true });
  });

  // ---- Bitcast
  /** This week's episode: the newest one not filed away. Created on demand. */
  function episode(create: boolean) {
    let e = db.prepare("SELECT * FROM bitcast WHERE filed_at IS NULL ORDER BY id DESC").get() as any;
    if (!e && create) e = db.prepare("SELECT * FROM bitcast WHERE id = ?").get(Number(db.prepare("INSERT INTO bitcast (day, created_at) VALUES (?, ?)").run(ctx.day(), now()).lastInsertRowid));
    return e;
  }
  const epView = (e: any) => {
    const f = e.file_id ? (db.prepare("SELECT name, size FROM files WHERE id = ?").get(e.file_id) as any) : null;
    const job = lastJob("bitcast", e.id);
    return { id: e.id, day: e.day, file: f, takes: JSON.parse(e.takes) as Array<{ text: string; ts: string; asked: string | null }>, report: e.report, job: job ? { status: job.status, reply: job.status === "failed" ? job.reply : null } : null, has_model: Boolean(ctx.modelFor("llm")) };
  };
  app.get("/api/work/bitcast", (c) => c.json(epView(episode(true))));
  app.post("/api/work/bitcast/rundown", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || !(/\.pdf$/i.test(file.name) || file.type === "application/pdf")) return bad(c, "Choose the rundown PDF.");
    const e = episode(true);
    let saved: StoredFile;
    try { saved = await saveFile(ctx, file, "work"); } catch (err) { return bad(c, (err as Error).message); }
    if (e.file_id) deleteFile(ctx, e.file_id);
    db.prepare("UPDATE bitcast SET file_id = ?, file_token = ?, day = ? WHERE id = ?").run(saved.id, randomBytes(24).toString("hex"), ctx.day(), e.id);
    return c.json(epView(episode(true)));
  });
  // Hermes collects the rundown from here. The link is long, random, and replaced with every new file.
  app.get("/api/work/handover/:token", (c) => {
    const e = db.prepare("SELECT * FROM bitcast WHERE file_token = ?").get(c.req.param("token").replace(/\.pdf$/, "")) as any;
    const f = e?.file_id ? (db.prepare("SELECT * FROM files WHERE id = ?").get(e.file_id) as StoredFile | undefined) : undefined;
    return f ? serve(f) : bad(c, "No such file.", 404);
  });
  const takeFrom = (e: any, reply: string, asked: string | null) => {
    const text = reply.match(INTRO)?.[1]?.trim();
    const takes = JSON.parse((db.prepare("SELECT takes FROM bitcast WHERE id = ?").get(e.id) as any).takes);
    if (text) takes.push({ text, ts: now(), asked });
    db.prepare("UPDATE bitcast SET takes = ?, report = ? WHERE id = ?").run(JSON.stringify(takes), reply.replace(INTRO, "").trim().slice(0, 20_000) || null, e.id);
  };
  const FORMAT = 'In your reply, put the intro text on its own between a line reading "<<<INTRO" and a line reading "INTRO>>>", then your usual report after it.';
  app.post("/api/work/bitcast/run", (c) => {
    const e = episode(true);
    if (!e.file_id) return bad(c, "Add the rundown PDF first.");
    if (!ctx.modelFor("llm")) return bad(c, "Set the deck model (Hermes) in Settings first.");
    if (working("bitcast", e.id)) return bad(c, "It's already running.", 409);
    const url = `${selfUrl()}/api/work/handover/${e.file_token}.pdf`;
    const first = `Bitcast prep. This is coming through the API, which can't carry attachments, so the prep PDF is waiting for you at ${url} (Life Architect, on this same Umbrel). Download it to /opt/data/bitcast-mac/runs/${e.day}.pdf and run the skill on it exactly as if I had sent it to you. ${FORMAT}`;
    runJob("bitcast", e.id, [{ role: "user", content: first }], (reply) => takeFrom(e, reply, null));
    return c.json({ started: true });
  });
  app.post("/api/work/bitcast/revise", async (c) => {
    const e = episode(true);
    const say = String(((await c.req.json().catch(() => ({}))) as any).say ?? "").trim().slice(0, 2000);
    if (!say) return bad(c, "Say what to change first.");
    if (working("bitcast", e.id)) return bad(c, "It's still working on the last one.", 409);
    const prev = db.prepare("SELECT messages FROM work_jobs WHERE kind = 'bitcast' AND ref = ? AND status = 'done' ORDER BY id DESC").get(e.id) as any;
    if (!prev) return bad(c, "Run the prep first.");
    const messages: Msg[] = [...JSON.parse(prev.messages), { role: "user", content: `Change the intro: ${say}\nKeep to the Bitcast skill's rules and update the sticky the way the skill does. ${FORMAT}` }];
    runJob("bitcast", e.id, messages, (reply) => takeFrom(e, reply, say));
    return c.json({ started: true });
  });
  // His own edit of a take, kept as a new take.
  app.post("/api/work/bitcast/takes", async (c) => {
    const e = episode(true);
    const text = String(((await c.req.json().catch(() => ({}))) as any).text ?? "").trim().slice(0, 4000);
    if (!text) return bad(c, "There's nothing to save.");
    const takes = JSON.parse(e.takes);
    takes.push({ text, ts: now(), asked: "Edited by hand" });
    db.prepare("UPDATE bitcast SET takes = ? WHERE id = ?").run(JSON.stringify(takes), e.id);
    return c.json(epView(episode(true)));
  });
  app.post("/api/work/bitcast/file", (c) => {
    const e = episode(false);
    if (e) db.prepare("UPDATE bitcast SET filed_at = ?, file_token = NULL WHERE id = ?").run(now(), e.id);
    return c.json({ ok: true });
  });
  app.get("/api/work/bitcast/:id", (c) => {
    const e = db.prepare("SELECT * FROM bitcast WHERE id = ?").get(Number(c.req.param("id"))) as any;
    return e ? c.json(epView(e)) : bad(c, "No such episode.", 404);
  });

  // ---- For Hermes (relay token): seed the list, and report progress on a tutorial.
  app.post("/api/relay/tutorials", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    let added = 0, seen = 0;
    for (const it of Array.isArray(b.items) ? b.items.slice(0, 300) : []) {
      const o = typeof it === "string" ? { title: it } : it;
      if (typeof o?.title !== "string") continue;
      seen++;
      if (addTutorial(o.title, { notes: o.notes, links: o.links, stage: o.stage, source: String(b.source ?? "hermes") })?.created) added++;
    }
    return seen ? c.json({ received: seen, added, already_there: seen - added }) : bad(c, 'Send {"items": [{"title": "...", "notes": "...", "links": [{"label": "...", "url": "..."}]}]}.');
  });
  app.get("/api/relay/tutorials", (c) => c.json({ tutorials: (db.prepare("SELECT * FROM tutorials WHERE filed_at IS NULL ORDER BY position, id").all() as any[]).map((t) => ({ title: t.title, stage: t.stage, has_outline: Boolean(t.outline) })) }));
  app.post("/api/relay/tutorial-update", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    const t = find(String(b.title ?? ""));
    if (!t) return bad(c, "No open tutorial matches that title.", 404);
    if (STAGES.includes(b.stage) && b.stage !== t.stage) { db.prepare("UPDATE tutorials SET stage = ?, updated_at = ? WHERE id = ?").run(b.stage, now(), t.id); log(t.id, `Hermes moved it to ${STAGE_NAMES[b.stage as Stage]}`); }
    if (typeof b.note === "string" && b.note.trim()) log(t.id, `Hermes: ${b.note.trim()}`);
    if (typeof b.link === "string" && /^https?:\/\//.test(b.link)) db.prepare("INSERT INTO tutorial_links (tutorial_id, label, url) VALUES (?, ?, ?)").run(t.id, String(b.link_label ?? "From Hermes").slice(0, 120), b.link.slice(0, 1000));
    if (typeof b.outline === "string" && b.outline.trim()) { db.prepare("UPDATE tutorials SET outline = ?, outline_from = 'Hermes', updated_at = ? WHERE id = ?").run(b.outline.slice(0, 60_000), now(), t.id); log(t.id, "Outline saved by Hermes"); }
    return c.json({ ok: true, title: t.title });
  });

  /** For the Claude connector. */
  return {
    list: () => (db.prepare("SELECT * FROM tutorials WHERE filed_at IS NULL ORDER BY (stage = 'idea'), position, id").all() as any[]).map((t) => ({ title: t.title, stage: STAGE_NAMES[t.stage as Stage], has_outline: Boolean(t.outline) })),
    addIdea: (title: string, notes?: string) => addTutorial(title, { notes, source: "claude" }),
    saveOutline: (name: string, outline: string, create: boolean) => {
      let t = find(name);
      if (!t && create) t = addTutorial(name, { source: "claude" })?.row;
      if (!t) return null;
      db.prepare("UPDATE tutorials SET outline = ?, outline_from = 'a voice session with Claude', stage = CASE WHEN stage = 'idea' THEN 'outline' ELSE stage END, updated_at = ? WHERE id = ?").run(outline.slice(0, 60_000), now(), t.id);
      log(t.id, "Outline saved from Claude");
      return tut(t.id).title as string;
    },
  };
}
