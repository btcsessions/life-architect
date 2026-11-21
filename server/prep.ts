// YouTube prep, seen and steered from the app. Hermes's own skill does the work (10–20 minutes): titles, description,
// tags, cards, sponsor reads, socials, Studio to-dos. The app starts it, hands over a thumbnail as a download link,
// asks for title and social edits and for scheduling once there is a release time, and keeps what comes back.
//
// Results arrive two ways, whichever comes first: Hermes POSTs them to /api/relay/youtube-prep when it finishes, and
// it ends its reply with the same JSON between <<<PREP and PREP>>>. While anything is pending, the app also asks
// Hermes for the state every few minutes, so a dropped reply never leaves the screen stuck.
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import type { Ctx } from "./app.ts";
import { chat } from "./file.ts";
import { saveFile, serve, deleteFile, type StoredFile } from "./files.ts";

export type PrepAction = "prep" | "fetch" | "title" | "thumbnail" | "social" | "schedule" | "other";
const ACTIONS: PrepAction[] = ["prep", "fetch", "title", "thumbnail", "social", "schedule", "other"];
const LABEL: Record<PrepAction, string> = { prep: "YouTube prep", fetch: "status check", title: "title change", thumbnail: "thumbnail", social: "post edit", schedule: "scheduling", other: "request" };
const PREP = /<<<PREP\s*([\s\S]*?)\s*PREP>>>/;
/** Minutes before the first status check, then between checks, and before giving up. */
const FIRST_CHECK: Record<PrepAction, number> = { prep: 12, fetch: 3, schedule: 6, title: 4, thumbnail: 4, social: 4, other: 5 };
const EVERY = 5;
const GIVE_UP = 4 * 60;

export interface Social { id: string; platform: string; label: string; text: string; state?: string }
export interface Prep {
  status?: string; note?: string; video_id?: string; title?: string;
  title_candidates?: Array<{ title: string; score?: number | string }>;
  description?: string; tags?: string; priority_tags?: string[]; chapters?: string;
  cards?: Array<{ time: string; teaser?: string; what?: string; link?: string }>;
  sponsor_reads?: Array<{ start?: string; end?: string; sponsor?: string; link?: string }>;
  pinned_comment?: string; end_screen?: string; thumbnail?: { set?: boolean; source?: string; note?: string };
  socials?: Social[]; privacy?: string; publish_at?: string | null; playlists?: string[];
  flags?: string[]; studio_todos?: string[]; prep_doc_path?: string;
}

const SCHEMA = `{"status": "done" | "working" | "failed", "note": "<one line on what happened or where it's at>",
 "video_id": "...", "title": "<the title live on YouTube>", "title_candidates": [{"title": "...", "score": 0}],
 "description": "<the description you wrote>", "tags": "<the comma string>", "priority_tags": ["..."], "chapters": "<as on the video>",
 "cards": [{"time": "M:SS", "teaser": "<30 characters or fewer>", "what": "<what the card points to>", "link": "<its URL>"}],
 "sponsor_reads": [{"start": "M:SS", "end": "M:SS", "sponsor": "...", "link": "..."}],
 "pinned_comment": "...", "end_screen": "...", "thumbnail": {"set": true, "source": "<Ben's, Daniel's...>", "note": "..."},
 "socials": [{"id": "x_hook" | "x_sponsor" | "facebook" | "nostr" | "community_1" | ..., "platform": "X" | "Facebook" | "Nostr" | "YouTube Community", "label": "<e.g. Hook tweet>", "text": "<the full post>", "state": "draft" | "scheduled" | "needs_signature" | "posted"}],
 "privacy": "private" | "unlisted" | "public", "publish_at": "<ISO time with offset, or null>", "playlists": ["..."],
 "flags": ["..."], "studio_todos": ["..."], "prep_doc_path": "..."}`;

const str = (v: unknown, max = 20_000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => str(x, 600)).filter((x): x is string => Boolean(x)).slice(0, 40) : typeof v === "string" && v.trim() ? [v.trim().slice(0, 600)] : undefined);

/** Socials as a list, whether Hermes sent the list asked for or its own {x_thread, facebook, nostr, community} shape. */
function socialsFrom(v: unknown): Social[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((s: any, i) => ({ id: str(s?.id, 40) ?? `post_${i + 1}`, platform: str(s?.platform, 40) ?? "Post", label: str(s?.label, 80) ?? str(s?.platform, 40) ?? "Post", text: str(s?.text, 5000) ?? "", state: str(s?.state, 40) })).filter((s) => s.text);
    return out.length ? out : undefined;
  }
  if (!v || typeof v !== "object") return undefined;
  const o = v as any, out: Social[] = [];
  const many = (x: unknown) => (Array.isArray(x) ? x : x == null ? [] : [x]).map((y: any) => (typeof y === "string" ? y : str(y?.text, 5000) ?? "")).filter(Boolean);
  many(o.x_thread ?? o.x ?? o.twitter).forEach((t, i) => out.push({ id: i === 0 ? "x_hook" : i === 1 ? "x_sponsor" : `x_${i + 1}`, platform: "X", label: i === 0 ? "Hook tweet" : i === 1 ? "Sponsor reply" : `Tweet ${i + 1}`, text: t }));
  many(o.facebook).forEach((t, i) => out.push({ id: i ? `facebook_${i + 1}` : "facebook", platform: "Facebook", label: "Facebook post", text: t }));
  many(o.nostr).forEach((t, i) => out.push({ id: i ? `nostr_${i + 1}` : "nostr", platform: "Nostr", label: "Nostr note", text: t }));
  many(o.community).forEach((t, i) => out.push({ id: `community_${i + 1}`, platform: "YouTube Community", label: `Community post${i ? ` ${i + 1}` : ""}`, text: t }));
  return out.length ? out : undefined;
}

/** Keep only what the screen knows how to show, in the shapes it expects. */
export function cleanPrep(raw: any): Prep {
  if (!raw || typeof raw !== "object") return {};
  const p: Prep = {
    status: str(raw.status, 20)?.toLowerCase(), note: str(raw.note, 600), video_id: str(raw.video_id, 40),
    title: str(raw.title, 200) ?? str(raw.title_applied, 200),
    title_candidates: Array.isArray(raw.title_candidates) ? raw.title_candidates.map((t: any) => (typeof t === "string" ? { title: t } : { title: str(t?.title, 200) ?? "", score: t?.score })).filter((t: any) => t.title).slice(0, 10) : undefined,
    description: str(raw.description), tags: Array.isArray(raw.tags) ? raw.tags.join(", ").slice(0, 600) : str(raw.tags, 600),
    priority_tags: list(raw.priority_tags), chapters: str(raw.chapters, 5000),
    cards: Array.isArray(raw.cards) ? raw.cards.map((c: any) => ({ time: str(c?.time ?? c?.timestamp, 12) ?? "", teaser: str(c?.teaser, 80), what: str(c?.what ?? c?.title ?? c?.type, 200), link: str(c?.link ?? c?.url, 1000) })).filter((c: any) => c.time || c.link).slice(0, 10) : undefined,
    sponsor_reads: Array.isArray(raw.sponsor_reads) ? raw.sponsor_reads.map((s: any) => ({ start: str(s?.start, 12), end: str(s?.end, 12), sponsor: str(s?.sponsor, 120), link: str(s?.link, 1000) })).slice(0, 10) : undefined,
    pinned_comment: str(raw.pinned_comment, 5000), end_screen: str(raw.end_screen, 2000),
    thumbnail: raw.thumbnail && typeof raw.thumbnail === "object" ? { set: Boolean(raw.thumbnail.set), source: str(raw.thumbnail.source, 120), note: str(raw.thumbnail.note, 600) } : undefined,
    socials: socialsFrom(raw.socials), privacy: str(raw.privacy, 20)?.toLowerCase(),
    publish_at: raw.publish_at === null ? null : str(raw.publish_at, 40), playlists: list(raw.playlists),
    flags: list(raw.flags), studio_todos: list(raw.studio_todos), prep_doc_path: str(raw.prep_doc_path, 400),
  };
  for (const k of Object.keys(p) as Array<keyof Prep>) if (p[k] === undefined) delete p[k];
  return p;
}

/** The JSON Hermes put between <<<PREP and PREP>>>, or null. */
export function prepFrom(reply: string): any | null {
  const block = reply.match(PREP)?.[1];
  if (!block) return null;
  const start = block.indexOf("{"), end = block.lastIndexOf("}");
  try { return JSON.parse(block.slice(start, end + 1)); } catch { return null; }
}

/** A release time typed on the Umbrel's clock (its TZ is Ben's) as ISO with the offset, e.g. 2026-11-25T09:00:00-07:00. */
export function withOffset(d: Date): string {
  const off = -d.getTimezoneOffset(), pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

interface Helpers { tut: (id: number) => any; log: (id: number, text: string) => void; find: (name: string) => any; selfUrl: () => string }

export function mountPrep(app: Hono, ctx: Ctx, h: Helpers) {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS tutorial_prep (
    tutorial_id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', pending TEXT, pending_since TEXT, last_check TEXT,
    checks INTEGER NOT NULL DEFAULT 0, error TEXT, reply TEXT, thumb_file_id INTEGER, thumb_token TEXT, review_task INTEGER, updated_at TEXT
  )`);
  const now = () => ctx.now().toISOString();
  const bad = (c: any, error: string, status = 400) => c.json({ error }, status);
  const row = (tid: number) => {
    db.prepare("INSERT OR IGNORE INTO tutorial_prep (tutorial_id, updated_at) VALUES (?, ?)").run(tid, now());
    return db.prepare("SELECT * FROM tutorial_prep WHERE tutorial_id = ?").get(tid) as any;
  };
  const data = (r: any): Prep => JSON.parse(r.data || "{}");
  const minutes = (since: string | null) => (since ? (ctx.now().getTime() - Date.parse(since)) / 60_000 : Infinity);
  const inFlight = (tid: number, kind: string) => Boolean(db.prepare("SELECT 1 FROM work_jobs WHERE kind = ? AND ref = ? AND status = 'working'").get(kind, tid));
  const thumbUrl = (r: any) => (r.thumb_token ? `${h.selfUrl()}/api/work/thumb/${r.thumb_token}.jpg` : null);

  /** Fold what Hermes sent into the tutorial's prep; settle whatever was pending. */
  function take(tid: number, action: PrepAction | "status", raw: any) {
    const t = h.tut(tid);
    if (!t) return;
    const r = row(tid);
    const got = cleanPrep(raw);
    const merged: Prep = { ...data(r), ...got };
    delete merged.status;
    db.prepare("UPDATE tutorial_prep SET data = ?, updated_at = ? WHERE tutorial_id = ?").run(JSON.stringify(merged), now(), tid);
    if (got.video_id && got.video_id !== t.video_id) db.prepare("UPDATE tutorials SET video_id = ?, updated_at = ? WHERE id = ?").run(got.video_id, now(), tid);
    const pending = r.pending as PrepAction | null;
    if (!pending) return;
    // A reply or report for the thing asked settles it; a status check settles it only once Hermes says it's done or stopped.
    const settles = action === pending ? got.status !== "working" : action === "status" && (got.status === "done" || got.status === "failed");
    if (!settles) return;
    if (got.status === "failed") {
      db.prepare("UPDATE tutorial_prep SET pending = NULL, pending_since = NULL, error = ? WHERE tutorial_id = ?").run(got.note ?? `Hermes said the ${LABEL[pending]} stopped.`, tid);
      h.log(tid, `${LABEL[pending][0].toUpperCase()}${LABEL[pending].slice(1)} stopped: ${got.note ?? "no reason given"}`);
      return;
    }
    db.prepare("UPDATE tutorial_prep SET pending = NULL, pending_since = NULL, error = NULL WHERE tutorial_id = ?").run(tid);
    const done = pending === "prep" ? "YouTube prep is ready" : pending === "fetch" ? "Got the latest from Hermes" : pending === "schedule" ? `Scheduled${merged.publish_at ? ` for ${merged.publish_at}` : ""}` : `Hermes finished the ${LABEL[pending]}`;
    h.log(tid, `${done}${got.note ? `: ${got.note}` : ""}`);
    // Something to come back to: a task in Work, so it shows in "Today, in order".
    if (pending === "prep") {
      const task = db.prepare("INSERT INTO tasks (area_id, title, note, importance, due, source, created_at) VALUES ('work', ?, ?, 3, ?, 'work', ?)")
        .run(`Review the YouTube prep for ${t.title}`.slice(0, 200), "Titles, thumbnail, cards and socials are in Work. Set a release time there when you have one.", ctx.day(), now());
      db.prepare("UPDATE tutorial_prep SET review_task = ? WHERE tutorial_id = ?").run(Number(task.lastInsertRowid), tid);
    }
    if (pending === "schedule" && r.review_task) db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(now(), r.review_task);
  }

  /** Send one message to Hermes in the background. Its reply may carry the result; a dropped reply is fine. */
  function send(tid: number, kind: "yt" | "yt_check", action: PrepAction | "status", content: string, timeoutMs: number) {
    const cfg = ctx.modelFor("llm");
    if (!cfg) return;
    const id = Number(db.prepare("INSERT INTO work_jobs (kind, ref, messages, created_at) VALUES (?, ?, ?, ?)").run(kind, tid, JSON.stringify([{ role: "user", content }]), now()).lastInsertRowid);
    const finish = (status: string, reply: string) => db.prepare("UPDATE work_jobs SET status = ?, reply = ?, done_at = ? WHERE id = ?").run(status, reply.slice(0, 40_000), now(), id);
    chat(cfg, [{ role: "user", content }], timeoutMs)
      .then((reply) => {
        finish("done", reply);
        const j = prepFrom(reply);
        if (j) take(tid, action, j);
        else if (kind === "yt") db.prepare("UPDATE tutorial_prep SET reply = ? WHERE tutorial_id = ?").run(reply.replace(PREP, "").trim().slice(0, 4000) || null, tid);
      })
      // Not an error to show: Hermes keeps going without the connection, and the checks pick it up.
      .catch((e) => finish("failed", (e as Error).message));
  }

  const finishWith = (t: any, action: PrepAction) => `When it's finished, POST the result to ${h.selfUrl()}/api/relay/youtube-prep with your relay token as JSON, {"tutorial": ${JSON.stringify(t.title)}, "action": "${action}", ...the fields below}, and end your reply here with the same JSON between a line reading "<<<PREP" and a line reading "PREP>>>". Leave out any field you don't have:\n${SCHEMA}`;
  const about = (t: any, p: Prep) => `"${t.title}"${p.video_id || t.video_id ? ` (video ${p.video_id || t.video_id})` : ""}`;

  /** Start something on the prep. Returns an error for Ben, or null once it's with Hermes. */
  function start(tid: number, action: PrepAction, b: { say?: string; title?: string; social?: string; release_at?: string }): string | null {
    const t = h.tut(tid);
    if (!t) return "No such tutorial.";
    if (!ctx.modelFor("llm")) return "Set the deck model (Hermes) in Settings first.";
    const r = row(tid), p = data(r);
    if (r.pending) return `Hermes is still on the ${LABEL[r.pending as PrepAction]}. It'll be free once that's back.`;
    const say = (b.say ?? "").trim().slice(0, 2000);
    let content: string, note: string;
    if (action === "prep") {
      const thumb = thumbUrl(r);
      content = `YouTube prep for "${t.title}".${t.video_id ? ` The video ID is ${t.video_id}.` : " Find the upload on the channel yourself, as you usually do."}${thumb ? ` I've added a thumbnail: download it from ${thumb} and use it as you usually would.` : ""}${p.publish_at ? ` Release time: ${p.publish_at}.` : " There's no release time yet, so draft the socials but don't schedule anything."}${say ? ` ${say}` : ""} ${finishWith(t, "prep")}`;
      note = "Asked Hermes for the YouTube prep";
    } else if (action === "fetch") {
      content = `What's the current state of the YouTube prep for ${about(t, p)}? Don't start or redo anything: read the live video, your prep doc, Buffer and the Nostr queue, and send back everything the prep has (titles, description, tags, cards, sponsor reads, socials, Studio to-dos), as it stands now. If a prep run is still going, set "status" to "working". If there's no prep for it at all yet, set "status" to "failed" and say so in "note". ${finishWith(t, "fetch")}`;
      note = "Asked Hermes for the latest on the YouTube prep";
    } else if (action === "title") {
      const exact = (b.title ?? "").trim().slice(0, 100);
      if (!exact && !say) return "Say what you want from the title.";
      content = exact
        ? `Change the YouTube title of ${about(t, p)} to exactly: ${exact}${say ? `. ${say}` : ""}. Re-score it with vidIQ as usual. ${finishWith(t, "title")}`
        : `I want a different YouTube title for ${about(t, p)}. The title now is ${JSON.stringify(p.title ?? t.title)}. What I want: ${say}. Give me fresh candidates scored with vidIQ, apply the best fit, and put the rest in title_candidates. ${finishWith(t, "title")}`;
      note = exact ? `Asked Hermes to change the title to "${exact}"` : `Asked Hermes for a new title: ${say}`;
    } else if (action === "thumbnail") {
      if (!r.thumb_token) return "Add the thumbnail image first.";
      content = `Here's my thumbnail for ${about(t, p)}: download it from ${thumbUrl(r)} and set it as you usually do (if Daniel's designed one is already live, keep his and make mine the Test & Compare alternate).${say ? ` ${say}` : ""} ${finishWith(t, "thumbnail")}`;
      note = "Sent the thumbnail to Hermes";
    } else if (action === "social") {
      const s = p.socials?.find((x) => x.id === b.social);
      if (!s) return "That post isn't in the prep.";
      if (!say) return "Say what to change.";
      content = `Revise the ${s.label} (${s.platform}) for ${about(t, p)}. What I want: ${say}. If I've given exact wording, use it verbatim. The current text is:\n"""\n${s.text}\n"""\nIf it's already scheduled, update the scheduled post too. Send back every social post, not just this one. ${finishWith(t, "social")}`;
      note = `Asked Hermes to change the ${s.label}: ${say}`;
    } else if (action === "schedule") {
      const when = new Date(b.release_at ?? "");
      if (Number.isNaN(when.getTime())) return "Pick a release date and time.";
      if (when.getTime() < ctx.now().getTime() + 20 * 60_000) return "Pick a time at least 20 minutes from now, so there's time to sign the Nostr note.";
      const iso = withOffset(when);
      content = `Schedule the release of ${about(t, p)} for ${iso}: set YouTube's publish time, schedule the X thread and Facebook post in Buffer for the same time and queue the Nostr note, as you usually do (confirm with me on Telegram first, and get the Nostr note signed).${say ? ` ${say}` : ""} If it was already scheduled, move everything to the new time. ${finishWith(t, "schedule")}`;
      note = `Asked Hermes to schedule the release for ${iso}`;
    } else {
      if (!say) return "Say what you need.";
      content = `About the YouTube prep for ${about(t, p)}: ${say} ${finishWith(t, "other")}`;
      note = `Asked Hermes: ${say}`;
    }
    db.prepare("UPDATE tutorial_prep SET pending = ?, pending_since = ?, last_check = NULL, checks = 0, error = NULL, reply = NULL WHERE tutorial_id = ?").run(action, now(), tid);
    h.log(tid, note);
    send(tid, "yt", action, content, 45 * 60_000);
    return null;
  }

  /** Ask Hermes where the pending thing is at. Cheap: it reads YouTube, its prep doc, Buffer and the Nostr queue. */
  function check(tid: number) {
    const t = h.tut(tid), r = row(tid), p = data(r);
    if (!t || !r.pending || inFlight(tid, "yt_check")) return;
    db.prepare("UPDATE tutorial_prep SET last_check = ?, checks = checks + 1 WHERE tutorial_id = ?").run(now(), tid);
    const content = `Status check on the ${LABEL[r.pending as PrepAction]} for ${about(t, p)}, asked ${Math.round(minutes(r.pending_since))} minutes ago from Life Architect. Don't start or redo anything: look at the live video, your prep doc, Buffer and the Nostr queue. Reply only with the current state between a line reading "<<<PREP" and a line reading "PREP>>>", with "status" set to "done" if the ${LABEL[r.pending as PrepAction]} has finished, "working" if it's still going, or "failed" if it stopped. Leave out any field you don't have:\n${SCHEMA}`;
    send(tid, "yt_check", "status", content, 5 * 60_000);
  }

  /** Runs every minute: check on anything Hermes is working on, and mark released videos live. */
  function tick() {
    for (const r of db.prepare("SELECT * FROM tutorial_prep WHERE pending IS NOT NULL").all() as any[]) {
      const age = minutes(r.pending_since);
      if (age > GIVE_UP) {
        db.prepare("UPDATE tutorial_prep SET pending = NULL, pending_since = NULL, error = ? WHERE tutorial_id = ?").run(`Hermes hasn't reported back on the ${LABEL[r.pending as PrepAction]} in ${GIVE_UP / 60} hours. Check Telegram, or ask from here.`, r.tutorial_id);
        h.log(r.tutorial_id, `Stopped waiting for the ${LABEL[r.pending as PrepAction]}`);
        continue;
      }
      if (age >= FIRST_CHECK[r.pending as PrepAction] && minutes(r.last_check) >= EVERY) check(r.tutorial_id);
    }
    for (const r of db.prepare("SELECT p.*, t.stage FROM tutorial_prep p JOIN tutorials t ON t.id = p.tutorial_id WHERE t.stage = 'youtube_prep'").all() as any[]) {
      const at = data(r).publish_at;
      if (at && Date.parse(at) <= ctx.now().getTime()) {
        db.prepare("UPDATE tutorials SET stage = 'live', updated_at = ? WHERE id = ?").run(now(), r.tutorial_id);
        h.log(r.tutorial_id, "Released on YouTube");
      }
    }
  }

  const view = (tid: number) => {
    const r = row(tid), p = data(r);
    const f = r.thumb_file_id ? (db.prepare("SELECT name, size FROM files WHERE id = ?").get(r.thumb_file_id) as any) : null;
    return {
      prep: p, started: Object.keys(p).length > 0 || Boolean(r.pending), pending: r.pending, pending_label: r.pending ? LABEL[r.pending as PrepAction] : null,
      pending_since: r.pending_since, last_check: r.last_check, checks: r.checks, error: r.error, reply: r.reply,
      thumbnail: f ? { name: f.name, url: `/api/work/tutorials/${tid}/prep/thumbnail?v=${r.thumb_file_id}` } : null,
      has_model: Boolean(ctx.modelFor("llm")),
    };
  };

  app.get("/api/work/tutorials/:id/prep", (c) => (h.tut(Number(c.req.param("id"))) ? c.json(view(Number(c.req.param("id")))) : bad(c, "No such tutorial.", 404)));
  app.post("/api/work/tutorials/:id/prep", async (c) => {
    const tid = Number(c.req.param("id"));
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (b.action === "check") {
      const r = row(tid);
      if (!r.pending) return bad(c, "Nothing is waiting on Hermes.");
      if (inFlight(tid, "yt_check")) return bad(c, "Already checking.", 409);
      check(tid);
      return c.json(view(tid));
    }
    if (!ACTIONS.includes(b.action)) return bad(c, "Unknown request.");
    const problem = start(tid, b.action, b);
    return problem ? bad(c, problem, problem.startsWith("Hermes is still") ? 409 : 400) : c.json(view(tid));
  });
  app.post("/api/work/tutorials/:id/prep/thumbnail", async (c) => {
    const tid = Number(c.req.param("id"));
    if (!h.tut(tid)) return bad(c, "No such tutorial.", 404);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || !/^image\/(png|jpe?g|webp)$/.test(file.type)) return bad(c, "Choose a PNG, JPG or WebP image.");
    let saved: StoredFile;
    try { saved = await saveFile(ctx, file, "work"); } catch (err) { return bad(c, (err as Error).message); }
    const r = row(tid);
    if (r.thumb_file_id) deleteFile(ctx, r.thumb_file_id);
    db.prepare("UPDATE tutorial_prep SET thumb_file_id = ?, thumb_token = ? WHERE tutorial_id = ?").run(saved.id, randomBytes(24).toString("hex"), tid);
    h.log(tid, "Thumbnail added");
    // Once there's a video to put it on, hand it straight over. Before that, the prep request carries it.
    const p = data(row(tid));
    const sent = !r.pending && (p.video_id || h.tut(tid).video_id) && ctx.modelFor("llm") ? start(tid, "thumbnail", {}) === null : false;
    return c.json({ ...view(tid), sent });
  });
  app.get("/api/work/tutorials/:id/prep/thumbnail", (c) => {
    const r = db.prepare("SELECT thumb_file_id FROM tutorial_prep WHERE tutorial_id = ?").get(Number(c.req.param("id"))) as any;
    const f = r?.thumb_file_id ? (db.prepare("SELECT * FROM files WHERE id = ?").get(r.thumb_file_id) as StoredFile | undefined) : undefined;
    return f ? serve(f) : bad(c, "No thumbnail.", 404);
  });
  // Hermes downloads the thumbnail from here. The link is long, random, and replaced with every new image.
  app.get("/api/work/thumb/:token", (c) => {
    const r = db.prepare("SELECT thumb_file_id FROM tutorial_prep WHERE thumb_token = ?").get(c.req.param("token").replace(/\.\w+$/, "")) as any;
    const f = r?.thumb_file_id ? (db.prepare("SELECT * FROM files WHERE id = ?").get(r.thumb_file_id) as StoredFile | undefined) : undefined;
    return f ? serve(f) : bad(c, "No such file.", 404);
  });
  // Hermes reports a finished prep, edit or schedule here (relay token required, see relay.ts).
  app.post("/api/relay/youtube-prep", async (c) => {
    const b = (await c.req.json().catch(() => null)) as any;
    if (!b || typeof b !== "object") return bad(c, "Send JSON.");
    const vid = str(b.video_id, 40);
    const t = (vid && (db.prepare("SELECT * FROM tutorials WHERE video_id = ? ORDER BY filed_at IS NOT NULL, id DESC").get(vid) as any)) || h.find(String(b.tutorial ?? b.title_of ?? ""));
    if (!t) return bad(c, `No tutorial matches ${JSON.stringify(b.tutorial ?? vid ?? "")}. Send "tutorial" with its title as listed by GET /api/relay/tutorials.`, 404);
    take(t.id, ACTIONS.includes(b.action) ? b.action : "status", b);
    return c.json({ ok: true, tutorial: t.title, pending: row(t.id).pending });
  });

  return { tick, start, view, take };
}
