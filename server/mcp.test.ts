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

async function setup() {
  const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 12, 0, 0));
  const { token } = await (await app.request("/api/settings/relay-token", { method: "POST" })).json();
  const http = startMcp(app, 0);
  await new Promise((ok) => http.once("listening", ok));
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  const connect = async (bearer: string) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${bearer}` } }, fetch: realFetch }));
    return client;
  };
  return { app, token, http, url, connect };
}
const said = (r: any) => r.content[0].text as string;

describe("the connector Claude uses from the phone", () => {
  it("refuses anyone without the token, without locking the real owner out", async () => {
    const { http, url, token, connect } = await setup();
    await expect(connect("wrong-token")).rejects.toThrow();
    for (let i = 0; i < 8; i++) expect((await realFetch(url, { method: "POST", headers: { ...J, authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
    expect((await realFetch(url, { method: "GET" })).status).toBe(401);
    const c = await connect(token); // still gets in after a stranger's wrong guesses
    expect((await c.listTools()).tools.length).toBe(8);
    await c.close(); http.close();
  });

  it("adds tasks, reads what's next, and keeps People out", async () => {
    const { app, token, http, connect } = await setup();
    const c = await connect(token);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["add_tutorial_idea", "check_tutorial", "do", "handoff_summary", "inbox", "save_tutorial_outline", "tutorials", "whats_next"]);
    const added = said(await c.callTool({ name: "do", arguments: { text: "Finish the YubiKey outline by Friday, important. Ask Nathan to redo the thumbnail" } }));
    expect(added).toContain("Finish the YubiKey outline");
    expect(added).toContain("handed to Nathan");
    expect(said(await c.callTool({ name: "whats_next", arguments: {} }))).toContain("1. Finish the YubiKey outline");
    expect(said(await c.callTool({ name: "inbox", arguments: {} }))).toContain("isn't connected");
    // People: refused here, and nothing lands in People's pile.
    expect(said(await c.callTool({ name: "do", arguments: { text: "People: Dana said she'd co-host" } }))).toContain("Not done");
    const cookie = (await app.request("/api/people/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) })).headers.get("set-cookie")!.split(";")[0];
    expect((await (await app.request("/api/people/home", { headers: { cookie } })).json()).inbox).toBe(0);
    await c.close(); http.close();
  });

  it("drives other modules by voice, and drafts email without sending it", async () => {
    const sent: unknown[] = [];
    const inbox = [{ uid: 1, message_id: "<1@x>", from_name: "Dana Test", from_addr: "dana@example.org", subject: "Workshop dates", date: "2026-11-18T11:00:00.000Z", text: "Second week of April?", references: "", bulk: false }];
    const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 12, 0, 0), { mail: () => ({ recent: async () => inbox, send: async (m) => { sent.push(m); } }) });
    const put = (b: unknown) => app.request("/api/settings", { method: "PUT", headers: J, body: JSON.stringify(b) });
    await put({ mail_user: "ben@example.com", mail_password: "x" });
    await app.request("/api/inbox/sync", { method: "POST" });
    await put({ llm_url: "http://model.test/v1", llm_model: "hermes-agent" });
    vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init: any) => {
      if (!String(u).startsWith("http://model.test")) return realFetch(u as any, init);
      const sys = JSON.parse(init.body).messages[0].content as string;
      const content = sys.includes("file a person's") ? JSON.stringify([{ kind: "trip", name: "Costa Rica", place: "Liberia", start: "2027-01-04", end: "2027-01-14" }, { kind: "expense", description: "Camera lens", amount: 420, direction: "out" }, { kind: "email", find: "Dana workshop", do: "reply", say: "april works" }]) : "April works. Please hold the room.";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));
    const { token } = await (await app.request("/api/settings/relay-token", { method: "POST" })).json();
    const http = startMcp(app, 0);
    await new Promise((ok) => http.once("listening", ok));
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: realFetch }));
    const out = said(await client.callTool({ name: "do", arguments: { text: "new trip to costa rica jan 4 to 14, log 420 for a camera lens, and reply to Dana that april works" } }));
    expect(out).toContain("Travel: Trip added: Costa Rica");
    expect(out).toContain("Money: Logged spending");
    expect(out).toContain("April works. Please hold the room.");
    expect(out).toContain("It has not been sent.");
    expect(sent).toHaveLength(0);
    expect(said(await client.callTool({ name: "inbox", arguments: {} }))).toContain("Dana Test: Workshop dates");
    await client.close(); http.close();
  });
});
