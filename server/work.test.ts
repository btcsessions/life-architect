import { describe, expect, it, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { startMcp } from "./mcp.ts";

const J = { "content-type": "application/json" };
const realFetch = globalThis.fetch;
afterEach(() => vi.unstubAllGlobals());
const settle = () => new Promise((r) => setTimeout(r, 25));
function make() {
  const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 20, 12, 0, 0));
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method, headers: { ...J, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => (await call(method, path, body, headers)).json() as Promise<any>;
  return { app, call, json };
}
/** Stand-in Hermes: answers by what it was last asked, and records every conversation it was sent. */
function hermes(answer: (last: string, all: any[]) => string) {
  const seen: any[][] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init: any) => {
    if (!String(u).startsWith("http://hermes.test")) return realFetch(u as any, init);
    const messages = JSON.parse(init.body).messages;
    seen.push(messages);
    return new Response(JSON.stringify({ choices: [{ message: { content: answer(messages.at(-1).content, messages) } }] }), { status: 200 });
  }));
  return seen;
}

describe("tutorial list", () => {
  it("adds ideas one at a time or as a pasted list, keeps my order, and files finished ones away", async () => {
    const { json, call } = make();
    await json("POST", "/api/work/tutorials", { title: "Obscura VPN", notes: "Problem-first hook" });
    const pasted = await json("POST", "/api/work/tutorials", { list: "- Silent.link eSIM\n2. Immich on Umbrel\n• obscura vpn\n\nVaultwarden", source: "Daniel's doc" });
    expect(pasted).toMatchObject({ added: 3, already_there: 1 });
    let w = await json("GET", "/api/work");
    expect(w.up_next.map((t: any) => t.title)).toEqual(["Obscura VPN", "Silent.link eSIM", "Immich on Umbrel", "Vaultwarden"]);
    const ids = w.up_next.map((t: any) => t.id);
    await json("POST", "/api/work/tutorials/order", { ids: [ids[3], ids[0], ids[2], ids[1]] });
    w = await json("GET", "/api/work");
    expect(w.up_next.map((t: any) => t.title)).toEqual(["Vaultwarden", "Obscura VPN", "Immich on Umbrel", "Silent.link eSIM"]);

    // Notes, links, an outline (which starts it moving), then on through the stages.
    const id = ids[0];
    await json("PATCH", `/api/work/tutorials/${id}`, { notes: "Show the kill switch" });
    expect((await call("POST", `/api/work/tutorials/${id}/links`, { url: "not a link" })).status).toBe(400);
    await json("POST", `/api/work/tutorials/${id}/links`, { label: "Product page", url: "https://obscura.example/" });
    await json("PATCH", `/api/work/tutorials/${id}`, { outline: "**Hook** the problem\n**Setup** install" });
    let t = await json("GET", `/api/work/tutorials/${id}`);
    expect(t).toMatchObject({ stage: "outline", notes: "Show the kill switch", has_outline: true, next_stage: { id: "record" } });
    expect(t.link_list[0].label).toBe("Product page");
    expect(t.stages.map((s: any) => s.state)).toEqual(["done", "now", "later", "later", "later", "later"]);
    w = await json("GET", "/api/work");
    expect(w.in_motion.map((x: any) => x.title)).toEqual(["Obscura VPN"]);
    expect(w.up_next).toHaveLength(3);
    await json("PATCH", `/api/work/tutorials/${id}`, { stage: "live" });
    await json("PATCH", `/api/work/tutorials/${id}`, { filed: true });
    w = await json("GET", "/api/work");
    expect([w.in_motion.length, w.filed]).toEqual([0, 1]);
    expect((await json("GET", "/api/work/filed")).tutorials[0].title).toBe("Obscura VPN");
    t = await json("GET", `/api/work/tutorials/${id}`);
    expect(t.log.map((l: any) => l.text)).toEqual(["Filed away", "Moved to Live", "Outline saved", "Idea added"]);
  });

  it("lets Hermes seed the list and report progress, only with the token", async () => {
    const { json, call } = make();
    expect((await call("POST", "/api/relay/tutorials", { items: ["x"] })).status).toBe(503);
    const { token } = await json("POST", "/api/settings/relay-token");
    const auth = { authorization: `Bearer ${token}` };
    expect((await call("POST", "/api/relay/tutorials", { items: ["x"] }, { authorization: "Bearer no" })).status).toBe(401);
    expect(await json("POST", "/api/relay/tutorials", { source: "Hermes list", items: [{ title: "GrapheneOS", notes: "Pixel only", links: [{ label: "Site", url: "https://grapheneos.example" }] }, "Mullvad VPN", { title: "grapheneos" }] }, auth)).toEqual({ received: 3, added: 2, already_there: 1 });
    const w = await json("GET", "/api/work");
    expect(w.up_next.map((t: any) => [t.title, t.source, t.links])).toEqual([["GrapheneOS", "Hermes list", 1], ["Mullvad VPN", "Hermes list", 0]]);
    expect(await json("POST", "/api/relay/tutorial-update", { title: "graphene", stage: "youtube_prep", note: "Line edit done, 14 min", link: "https://drive.example/folder" }, auth)).toMatchObject({ ok: true, title: "GrapheneOS" });
    const t = await json("GET", `/api/work/tutorials/${w.up_next[0].id}`);
    expect(t.stage).toBe("youtube_prep");
    expect(t.log[0].text).toBe("Hermes: Line edit done, 14 min");
    expect(t.link_list).toHaveLength(2);
    expect((await call("POST", "/api/relay/tutorial-update", { title: "nothing like it" }, auth)).status).toBe(404);
  });
});

describe("Hermes skills from the Work area", () => {
  it("runs YouTube prep with the video ID and carries the conversation into a follow-up", async () => {
    const { json, call } = make();
    const { tutorial } = await json("POST", "/api/work/tutorials", { title: "Radar Chat" });
    expect((await call("POST", `/api/work/tutorials/${tutorial.id}/run`, { skill: "youtube_prep" })).status).toBe(400); // no model yet
    await json("PUT", "/api/settings", { llm_url: "http://hermes.test/v1", llm_model: "hermes-agent" });
    const seen = hermes((last) => (last.startsWith("YouTube prep") ? "Prep written. Three titles scored." : "Swapped to title two."));
    await json("PATCH", `/api/work/tutorials/${tutorial.id}`, { video_id: "abc123XYZ" });
    await json("POST", `/api/work/tutorials/${tutorial.id}/run`, { skill: "youtube_prep" });
    await settle();
    let t = await json("GET", `/api/work/tutorials/${tutorial.id}`);
    expect(t.stage).toBe("youtube_prep");
    expect(t.jobs.youtube_prep).toMatchObject({ status: "done", reply: "Prep written. Three titles scored." });
    expect(seen[0][0].content).toBe('YouTube prep for "Radar Chat". The private upload\'s video ID is abc123XYZ.');
    await json("POST", `/api/work/tutorials/${tutorial.id}/run`, { skill: "youtube_prep", say: "use the second title" });
    await settle();
    expect(seen[1].map((m: any) => m.role)).toEqual(["user", "assistant", "user"]); // the whole exchange is resent
    t = await json("GET", `/api/work/tutorials/${tutorial.id}`);
    expect(t.jobs.youtube_prep.reply).toBe("Swapped to title two.");
  });

  it("starts a line edit by the footage folder name and leaves the back-and-forth to Telegram", async () => {
    const { json } = make();
    await json("PUT", "/api/settings", { llm_url: "http://hermes.test/v1", llm_model: "hermes-agent" });
    const seen = hermes(() => "Started. I'll message you on Telegram.");
    const { tutorial } = await json("POST", "/api/work/tutorials", { title: "PPQ.ai walkthrough" });
    await json("PATCH", `/api/work/tutorials/${tutorial.id}`, { folder: "ppq" });
    await json("POST", `/api/work/tutorials/${tutorial.id}/run`, { skill: "line_edit" });
    await settle();
    expect(seen[0][0].content).toMatch(/^Line edit ppq\./);
    expect(seen[0][0].content).toContain("Telegram");
    expect(seen[0][0].content).toContain('"title": "PPQ.ai walkthrough"');
    expect((await json("GET", `/api/work/tutorials/${tutorial.id}`)).jobs.line_edit.reply).toContain("Telegram");
  });

  it("Bitcast: hands Hermes the rundown as a link, shows the intro hook, and keeps every take", async () => {
    const { app, json, call } = make();
    await json("PUT", "/api/settings", { llm_url: "http://hermes.test/v1", llm_model: "hermes-agent" });
    expect((await call("POST", "/api/work/bitcast/run")).status).toBe(400); // no rundown yet
    const up = (name: string, type: string) => { const f = new FormData(); f.set("file", new File(["%PDF-1.4 fake rundown"], name, { type })); return app.request("/api/work/bitcast/rundown", { method: "POST", body: f }); };
    expect((await up("notes.txt", "text/plain")).status).toBe(400);
    expect((await (await up("rundown.pdf", "application/pdf")).json()).file.name).toBe("rundown.pdf");
    const seen = hermes((last) => last.startsWith("Bitcast prep")
      ? "<<<INTRO\nTease one. Tease two. Tease three. You're not gonna want to miss this one.\nINTRO>>>\nReached the sticky. 71 words. Windows opened."
      : "<<<INTRO\nTease one, sharper. Tease two. Tease three?\nINTRO>>>\nSticky updated.");
    await json("POST", "/api/work/bitcast/run");
    await settle();
    let ep = await json("GET", "/api/work/bitcast");
    expect(ep.takes).toHaveLength(1);
    expect(ep.takes[0].text).toContain("Tease one. Tease two.");
    expect(ep.report).toBe("Reached the sticky. 71 words. Windows opened.");
    // Hermes was told where to fetch the PDF, and that link really serves it.
    const link = seen[0][0].content.match(/http:\/\/\S+\.pdf/)![0];
    expect(link.startsWith("http://btcsessions-life-architect_web_1:4600/api/work/handover/")).toBe(true);
    const fetched = await app.request(new URL(link).pathname);
    expect([fetched.status, await fetched.text()]).toEqual([200, "%PDF-1.4 fake rundown"]);
    expect((await app.request("/api/work/handover/guess.pdf")).status).toBe(404);

    await json("POST", "/api/work/bitcast/revise", { say: "punch up the first tease, make the third a question" });
    await settle();
    ep = await json("GET", "/api/work/bitcast");
    expect(ep.takes.map((t: any) => t.asked)).toEqual([null, "punch up the first tease, make the third a question"]);
    expect(seen[1].map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    await json("POST", "/api/work/bitcast/takes", { text: "My own wording." });
    expect((await json("GET", "/api/work/bitcast")).takes).toHaveLength(3);
    // Filing it starts a clean one for next week, and the old link stops working.
    await json("POST", "/api/work/bitcast/file");
    expect((await json("GET", "/api/work/bitcast")).takes).toHaveLength(0);
    expect((await app.request(new URL(link).pathname)).status).toBe(404);
    expect((await json("GET", "/api/work/filed")).episodes).toHaveLength(1);
  });
});

describe("outlines from a voice session with Claude", () => {
  it("lists tutorials, adds an idea, and saves an outline onto the right one", async () => {
    const { app, json } = make();
    await json("POST", "/api/work/tutorials", { title: "YubiKey, going in blind" });
    const { token } = await json("POST", "/api/settings/relay-token");
    const http = startMcp(app, 0);
    await new Promise((ok) => http.once("listening", ok));
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const said = async (name: string, args: Record<string, unknown>) => ((await c.callTool({ name, arguments: args })) as any).content[0].text as string;
    expect(await said("tutorials", {})).toContain("YubiKey, going in blind (Idea)");
    expect(await said("add_tutorial_idea", { title: "Coldcard Q", notes: "After the firmware fork" })).toContain("Added");
    expect(await said("save_tutorial_outline", { tutorial: "yubikey", outline: "**Hook** locked out of everything\n**Unbox** what's in it\n**Setup** first key" })).toContain('Outline saved on "YubiKey, going in blind"');
    const w = await json("GET", "/api/work");
    expect(w.in_motion[0]).toMatchObject({ title: "YubiKey, going in blind", stage: "outline", has_outline: true });
    const t = await json("GET", `/api/work/tutorials/${w.in_motion[0].id}`);
    expect(t.outline_from).toBe("a voice session with Claude");
    expect(await said("save_tutorial_outline", { tutorial: "Something unknown", outline: "**Hook** twenty characters at least", create_if_missing: false })).toContain("Not saved");
    await c.close(); http.close();
  });
});
