import { describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { fileByRules } from "./file.ts";

const J = { "content-type": "application/json" };
function make() {
  const sent: any[] = [];
  const inbox = [{ uid: 1, message_id: "<1@x>", from_name: "Acme", from_addr: "partners@acme.com", subject: "Affiliate terms", date: "2026-11-18T10:00:00.000Z", text: "Your code is BEN10, 15% commission.", references: "", bulk: false }];
  const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 9, 0, 0), { mail: () => ({ recent: async () => inbox, send: async (m) => { sent.push(m); } }) });
  const send = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => app.request(path, { method, headers: { ...J, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { send };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
afterEach(() => vi.unstubAllGlobals());

/** A stand-in model: files by the reply given, and answers asks. Records what it was sent. */
function model(filed: unknown[]) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const msgs = JSON.parse(init.body).messages;
    seen.push(msgs[1].content);
    const content = msgs[0].content.includes("file a person's") ? JSON.stringify(filed) : "Noted the affiliate details for the tutorial.";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }));
  return seen;
}

describe("asks", () => {
  it("rules tell an instruction for the assistant from a task for me", () => {
    const kind = (t: string) => fileByRules(t, "2026-11-19")[0].kind;
    expect(kind("Make note of the affiliate information in that email for a later tutorial")).toBe("ask");
    expect(kind("Hermes, look up flights to Liberia")).toBe("ask");
    expect(kind("Can you summarize the Radar Chat docs")).toBe("ask");
    expect(kind("Finish the YubiKey outline by Thursday")).toBe("task");
    expect(kind("Remind me to call the dentist")).toBe("task");
    expect(kind("Ask Nathan to redo the thumbnail")).toBe("task");
  });

  it("sends an ask to the assistant instead of adding a task, and shows the answer on the deck", async () => {
    const { send } = make();
    await send("PUT", "/api/settings", { llm_url: "http://model/v1", llm_model: "hermes-agent" });
    const seen = model([{ area: "work", title: "Make note of the affiliate info for a later tutorial", kind: "ask" }, { area: "family", title: "Book Santa photos", kind: "task" }]);
    const r = await (await send("POST", "/api/capture", { text: "make note of the affiliate info for a later tutorial. book santa photos" })).json();
    expect(r.created.map((t: any) => t.title)).toEqual(["Book Santa photos"]);
    expect(r.asked).toHaveLength(1);
    await settle();
    const deck = await (await send("GET", "/api/deck")).json();
    expect(deck.asks[0]).toMatchObject({ status: "done", reply: "Noted the affiliate details for the tutorial." });
    expect(seen[1]).toContain("affiliate info");

    // Wrong guess: turn it back into a task for me.
    await send("POST", `/api/asks/${deck.asks[0].id}/task`);
    const after = await (await send("GET", "/api/deck")).json();
    expect(after.asks).toHaveLength(0);
    expect(after.areas.flatMap((a: any) => a.items).map((t: any) => t.title)).toContain("Make note of the affiliate info for a later tutorial");
  });

  it("never turns something relayed in by Hermes into an ask", async () => {
    const { send } = make();
    await send("PUT", "/api/settings", { llm_url: "http://model/v1", llm_model: "hermes-agent" });
    model([{ area: "work", title: "Look up flights", kind: "ask" }]);
    const { token } = await (await send("POST", "/api/settings/relay-token")).json();
    const r = await send("POST", "/api/capture", { text: "look up flights", source: "hermes" });
    const body = await r.json();
    expect(body.asked).toHaveLength(0);
    expect(body.created).toHaveLength(1);
    expect(token).toBeTruthy();
  });

  it("from an email: a task in my words keeps the email, and an ask carries the email with it", async () => {
    const { send } = make();
    await send("PUT", "/api/settings", { mail_user: "ben@example.com", mail_password: "x", llm_url: "http://model/v1", llm_model: "hermes-agent" });
    const seen = model([{ area: "work", title: "Sign up for the Acme affiliate program", kind: "ask" }]);
    await send("POST", "/api/inbox/sync");
    const { token } = await (await send("POST", "/api/settings/relay-token")).json();
    await send("POST", "/api/relay/mail-run", { source: "triage", items: [{ message_id: "<1@x>", from_name: "Acme", subject: "Affiliate terms", summary: "Affiliate code and terms." }] }, { authorization: `Bearer ${token}` });
    const box = await (await send("GET", "/api/inbox")).json();
    const id = (await (await send("GET", `/api/inbox/item/${box.you[0].id}`)).json()).mail_id;

    const t = await (await send("POST", `/api/inbox/${id}/task`, { text: "sign up for the acme affiliate program" })).json();
    expect(t.created).toHaveLength(1); // a task even though the model called it an ask
    const deck = await (await send("GET", "/api/deck")).json();
    expect(deck.areas.flatMap((a: any) => a.items)[0].note).toContain("Affiliate terms");
    // The item leaves the Inbox: it's on the deck now.
    expect((await (await send("GET", "/api/inbox")).json()).handled[0]).toMatchObject({ subject: "Affiliate terms", done_how: "Made a task" });

    await send("POST", "/api/asks", { text: "make note of the affiliate info for a later tutorial", mail_id: id });
    await settle();
    expect(seen.at(-1)).toContain("BEN10");
    const asks = (await (await send("GET", "/api/asks")).json()).asks;
    expect(asks[0]).toMatchObject({ status: "done", context_label: "email from Acme: Affiliate terms" });
  });

  it("with no model, an instruction is kept as a task rather than lost", async () => {
    const { send } = make();
    const r = await (await send("POST", "/api/capture", { text: "Look up flights to Liberia" })).json();
    expect(r.asked).toHaveLength(0);
    expect(r.created).toHaveLength(1);
  });
});
