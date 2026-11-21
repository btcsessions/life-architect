import { describe, expect, it, afterEach, vi } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { cleanPrep } from "./prep.ts";

const J = { "content-type": "application/json" };
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());
const settle = () => new Promise((r) => setTimeout(r, 25));
function make() {
  let clock = new Date(2026, 10, 20, 12, 0, 0);
  const db = openDb(":memory:");
  const app = createApp(db, () => clock);
  const tasks = () => db.prepare("SELECT title, status FROM tasks WHERE area_id = 'work'").all() as Array<{ title: string; status: string }>;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method, headers: { ...J, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => (await call(method, path, body, headers)).json() as Promise<any>;
  const later = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); };
  return { app, call, json, later, tasks };
}
/** Stand-in Hermes. Answers by what it was last asked; `null` means the connection drops, as a long run's did. */
function hermes(answer: (last: string) => string | null) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init: any) => {
    if (!String(u).startsWith("http://hermes.test")) return realFetch(u as any, init);
    const last = JSON.parse(init.body).messages.at(-1).content;
    seen.push(last);
    const a = answer(last);
    if (a === null) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ choices: [{ message: { content: a } }] }), { status: 200 });
  }));
  return seen;
}
const block = (o: unknown) => `Done.\n<<<PREP\n${JSON.stringify(o)}\nPREP>>>`;
const FULL = {
  status: "done", note: "Applied title 1, description, 13 tags, private.", video_id: "yI0o72uSH8E", title: "Don't Use Sparrow Until You See This",
  title_candidates: [{ title: "Don't Use Sparrow Until You See This", score: 71 }, { title: "Sparrow Wallet: The Complete Guide", score: 64 }],
  description: "Sparrow is the wallet…", tags: "btc sessions, sovereign sessions, sparrow wallet", priority_tags: ["sparrow wallet"],
  cards: [{ time: "2:14", teaser: "Set up a Coldcard first", what: "Coldcard Q tutorial", link: "https://youtu.be/abcdefghijk" }],
  sponsor_reads: [{ start: "0:45", end: "1:30", sponsor: "Bitkey", link: "https://bitkey.world" }],
  pinned_comment: "Which wallet next?", thumbnail: { set: false, note: "No image supplied" },
  socials: { x_thread: ["Most people set up Sparrow wrong.", "Thanks to Bitkey for sponsoring."], facebook: "New video: Sparrow.", nostr: "Sparrow, start to finish.", community: ["Poll: which wallet next?"] },
  privacy: "private", publish_at: null, flags: ["Seed words visible at 4:02"], studio_todos: ["Add end screen", "Add cards"],
};

async function readyTutorial(json: any, title = "Sparrow Wallet Omnibus") {
  await json("PUT", "/api/settings", { llm_url: "http://hermes.test/v1", llm_model: "hermes-agent" });
  const { tutorial } = await json("POST", "/api/work/tutorials", { title });
  await json("PATCH", `/api/work/tutorials/${tutorial.id}`, { stage: "youtube_prep" });
  return tutorial.id as number;
}

describe("YouTube prep", () => {
  it("reads Hermes's own socials shape and its list shape into one list of posts", () => {
    const p = cleanPrep(FULL);
    expect(p.socials!.map((s) => [s.id, s.platform, s.label])).toEqual([
      ["x_hook", "X", "Hook tweet"], ["x_sponsor", "X", "Sponsor reply"], ["facebook", "Facebook", "Facebook post"], ["nostr", "Nostr", "Nostr note"], ["community_1", "YouTube Community", "Community post"],
    ]);
    expect(cleanPrep({ socials: [{ id: "x_hook", platform: "X", label: "Hook", text: "hi" }, { platform: "Nostr", text: "" }] }).socials).toEqual([{ id: "x_hook", platform: "X", label: "Hook", text: "hi", state: undefined }]);
    expect(cleanPrep({ cards: [{ timestamp: "1:00", title: "Next video", url: "https://x.test" }] }).cards).toEqual([{ time: "1:00", teaser: undefined, what: "Next video", link: "https://x.test" }]);
  });

  it("survives the dropped connection: checks in on Hermes until it's done, then leaves a task to review", async () => {
    const { app, json, later, tasks } = make();
    const id = await readyTutorial(json);
    let finished = false;
    const seen = hermes((last) => (last.startsWith("YouTube prep") ? null : finished ? block(FULL) : block({ status: "working", note: "Scoring titles" })));
    await json("POST", `/api/work/tutorials/${id}/run`, { skill: "youtube_prep" });
    await settle();
    expect(seen[0]).toMatch(/^YouTube prep for "Sparrow Wallet Omnibus"\. Find the upload on the channel yourself.*There's no release time yet/);
    expect(seen[0]).toContain("/api/relay/youtube-prep");
    let v = await json("GET", `/api/work/tutorials/${id}/prep`);
    expect([v.pending, v.error]).toEqual(["prep", null]); // the dropped reply isn't an error

    later(5); app.work.tick(); await settle();
    expect(seen).toHaveLength(1); // too early to ask
    later(8); app.work.tick(); await settle();
    expect(seen[1]).toMatch(/^Status check on the YouTube prep for "Sparrow Wallet Omnibus"/);
    expect((await json("GET", `/api/work/tutorials/${id}/prep`)).pending).toBe("prep");
    later(2); app.work.tick(); await settle();
    expect(seen).toHaveLength(2); // not again so soon

    finished = true;
    later(4); app.work.tick(); await settle();
    v = await json("GET", `/api/work/tutorials/${id}/prep`);
    expect([v.pending, v.prep.title, v.prep.cards[0].time, v.prep.socials.length]).toEqual([null, "Don't Use Sparrow Until You See This", "2:14", 5]);
    const t = await json("GET", `/api/work/tutorials/${id}`);
    expect([t.video_id, t.log[0].text]).toEqual(["yI0o72uSH8E", "YouTube prep is ready: Applied title 1, description, 13 tags, private."]);
    expect(tasks()).toEqual([{ title: "Review the YouTube prep for Sparrow Wallet Omnibus", status: "open" }]);
  });

  it("takes the result Hermes posts to the relay, by title or video ID", async () => {
    const { json, call } = make();
    const id = await readyTutorial(json);
    hermes(() => "Started.");
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "prep" });
    await settle();
    const { token } = await json("POST", "/api/settings/relay-token");
    const auth = { authorization: `Bearer ${token}` };
    expect((await call("POST", "/api/relay/youtube-prep", { tutorial: "Sparrow", ...FULL })).status).toBe(401);
    expect((await call("POST", "/api/relay/youtube-prep", { tutorial: "Nope", ...FULL }, auth)).status).toBe(404);
    expect(await json("POST", "/api/relay/youtube-prep", { tutorial: "Sparrow", action: "prep", ...FULL }, auth)).toEqual({ ok: true, tutorial: "Sparrow Wallet Omnibus", pending: null });
    // Later reports find it by video ID.
    expect(await json("POST", "/api/relay/youtube-prep", { video_id: "yI0o72uSH8E", action: "title", title: "My own title" }, auth)).toMatchObject({ ok: true });
    expect((await json("GET", `/api/work/tutorials/${id}/prep`)).prep.title).toBe("My own title");
  });

  it("asks for a title change, a post edit and a release time, one at a time", async () => {
    const { app, json, call, later, tasks } = make();
    const id = await readyTutorial(json);
    let reply = block(FULL);
    const seen = hermes(() => reply);
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "prep" });
    await settle();

    reply = block({ status: "done", title: "Sparrow Wallet: The Complete Guide" });
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "title", title: "Sparrow Wallet: The Complete Guide" });
    await settle();
    expect(seen.at(-1)).toMatch(/^Change the YouTube title of "Sparrow Wallet Omnibus" \(video yI0o72uSH8E\) to exactly: Sparrow Wallet: The Complete Guide\./);
    expect((await json("GET", `/api/work/tutorials/${id}/prep`)).prep.title).toBe("Sparrow Wallet: The Complete Guide");

    expect((await call("POST", `/api/work/tutorials/${id}/prep`, { action: "social", social: "x_hook" })).status).toBe(400);
    reply = "Working on it."; // no block: stays pending until a check or the relay says otherwise
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "social", social: "x_hook", say: "Lead with the fee savings" });
    await settle();
    expect(seen.at(-1)).toContain('Revise the Hook tweet (X) for "Sparrow Wallet Omnibus" (video yI0o72uSH8E). What I want: Lead with the fee savings.');
    expect(seen.at(-1)).toContain("Most people set up Sparrow wrong.");
    const busy = await call("POST", `/api/work/tutorials/${id}/prep`, { action: "schedule", release_at: "2026-11-25T09:00" });
    expect([busy.status, (await busy.json()).error]).toEqual([409, "Hermes is still on the post edit. It'll be free once that's back."]);
    reply = block({ status: "done", socials: [{ id: "x_hook", platform: "X", label: "Hook tweet", text: "Save on fees with Sparrow." }] });
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "check" });
    await settle();
    let v = await json("GET", `/api/work/tutorials/${id}/prep`);
    expect([v.pending, v.prep.socials[0].text, v.prep.socials.length]).toEqual([null, "Save on fees with Sparrow.", 1]);

    expect((await call("POST", `/api/work/tutorials/${id}/prep`, { action: "schedule", release_at: "2026-11-20T12:10" })).status).toBe(400);
    reply = block({ status: "done", publish_at: "2026-11-25T09:00:00-07:00", socials: [{ id: "x_hook", platform: "X", label: "Hook tweet", text: "Save on fees with Sparrow.", state: "scheduled" }] });
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "schedule", release_at: "2026-11-25T09:00" });
    await settle();
    expect(seen.at(-1)).toMatch(/^Schedule the release of "Sparrow Wallet Omnibus" \(video yI0o72uSH8E\) for 2026-11-25T09:00:00[-+]\d\d:\d\d/);
    v = await json("GET", `/api/work/tutorials/${id}/prep`);
    expect([v.pending, v.prep.publish_at]).toEqual([null, "2026-11-25T09:00:00-07:00"]);
    expect(tasks()).toEqual([{ title: "Review the YouTube prep for Sparrow Wallet Omnibus", status: "done" }]); // scheduling closes the review

    // Once the release time passes, the tutorial goes live by itself.
    app.work.tick();
    expect((await json("GET", `/api/work/tutorials/${id}`)).stage).toBe("youtube_prep");
    later(5 * 24 * 60);
    app.work.tick();
    const t = await json("GET", `/api/work/tutorials/${id}`);
    expect([t.stage, t.log[0].text]).toEqual(["live", "Released on YouTube"]);
  });

  it("holds a thumbnail until there's a video, then hands it to Hermes as a download link", async () => {
    const { app, json, call } = make();
    const id = await readyTutorial(json, "Radar Chat");
    const seen = hermes((last) => (last.startsWith("YouTube prep") ? block({ ...FULL, video_id: "radarvid001" }) : block({ status: "done", thumbnail: { set: true, source: "Ben's" } })));
    const up = (name: string, type: string) => { const f = new FormData(); f.append("file", new File([new Uint8Array([1, 2, 3])], name, { type })); return app.request(`/api/work/tutorials/${id}/prep/thumbnail`, { method: "POST", body: f }); };
    expect((await up("notes.pdf", "application/pdf")).status).toBe(400);
    const first = await (await up("thumb.png", "image/png")).json();
    expect([first.sent, first.thumbnail.name]).toEqual([false, "thumb.png"]);
    await json("POST", `/api/work/tutorials/${id}/prep`, { action: "prep" });
    await settle();
    const url = seen[0].match(/download it from (\S+\.jpg)/)![1];
    expect(url).toMatch(/^http:\/\/btcsessions-life-architect_web_1:4600\/api\/work\/thumb\/[0-9a-f]{48}\.jpg$/);
    expect((await call("GET", url.replace(/^http:\/\/[^/]+/, ""))).status).toBe(200);
    // A new image once the video exists goes straight over.
    const second = await (await up("thumb2.jpg", "image/jpeg")).json();
    await settle();
    expect(second.sent).toBe(true);
    expect(seen.at(-1)).toMatch(/^Here's my thumbnail for "Radar Chat" \(video radarvid001\): download it from http/);
    expect((await call("GET", url.replace(/^http:\/\/[^/]+/, ""))).status).toBe(404); // the old link is dead
    expect((await json("GET", `/api/work/tutorials/${id}/prep`)).prep.thumbnail).toEqual({ set: true, source: "Ben's" });
  });
});
