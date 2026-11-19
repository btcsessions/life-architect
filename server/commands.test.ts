import { describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

const J = { "content-type": "application/json" };
function make() {
  const sent: any[] = [];
  const inbox = [
    { uid: 1, message_id: "<1@x>", from_name: "Acme Partners", from_addr: "partners@acme.com", subject: "Affiliate terms", date: "2026-11-18T10:00:00.000Z", text: "Your code is BEN10.", references: "", bulk: false },
    { uid: 2, message_id: "<2@x>", from_name: "Dana Test", from_addr: "dana@example.org", subject: "Workshop dates", date: "2026-11-18T11:00:00.000Z", text: "Second week of April?", references: "", bulk: false },
  ];
  const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 9, 0, 0), { mail: () => ({ recent: async () => inbox, send: async (m) => { sent.push(m); } }) });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method, headers: { ...J, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { send, sent };
}
afterEach(() => vi.unstubAllGlobals());
/** A stand-in model that returns whatever actions the test queues, and records the prompts it saw. */
function model(queue: unknown[][]) {
  const seen: Array<{ system: string; user: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const m = JSON.parse(init.body).messages;
    seen.push({ system: m[0].content, user: m[1].content });
    const content = m[0].content.includes("file a person's") ? JSON.stringify(queue.shift() ?? []) : m[0].content.includes("email reply") ? "April works. Please hold the room." : "Noted.";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }));
  return seen;
}
const add = async (send: any, text: string) => (await send("POST", "/api/capture", { text })).json();

describe("driving modules from the main screen", () => {
  it("adds a trip, a booking on it, and a cost", async () => {
    const { send } = make();
    await send("PUT", "/api/settings", { llm_url: "http://m/v1", llm_model: "hermes-agent" });
    const seen = model([
      [{ kind: "trip", name: "Costa Rica", place: "Liberia", start: "2027-01-04", end: "2027-01-14", budget: 4000 }],
      [{ kind: "trip_item", trip_id: 1, type: "flight", title: "WestJet YYC to LIR", day: "2027-01-04", time: "08:15", cost: 900, booked: true }, { kind: "trip_item", trip_id: 99, type: "stay", title: "Nowhere" }],
    ]);
    let r = await add(send, "new trip to Costa Rica Jan 4 to 14, budget 4000");
    expect(r.did[0]).toMatchObject({ module: "Travel", ok: true, text: "Trip added: Costa Rica", open: "travel" });
    r = await add(send, "booked the WestJet flight for Costa Rica, Jan 4 at 8:15, 900 dollars");
    expect(r.did[0]).toMatchObject({ ok: true, text: "Added to Costa Rica: WestJet YYC to LIR" });
    expect(r.did[1]).toMatchObject({ ok: false }); // an id it made up is refused
    expect(seen[1].system).toContain('"name":"Costa Rica"'); // it was told which trips exist
    const trip = await (await send("GET", "/api/trips/1")).json();
    expect(trip.items).toHaveLength(1);
  });

  it("marks tasks done and changes them", async () => {
    const { send } = make();
    await add(send, "Family Santa photos. Finish the YubiKey outline");
    await send("PUT", "/api/settings", { llm_url: "http://m/v1", llm_model: "hermes-agent" });
    model([[{ kind: "done", task_id: 1 }, { kind: "change", task_id: 2, due: "2026-11-21", importance: 3 }, { kind: "done", task_id: 77 }]]);
    const r = await add(send, "santa photos are done, and move the yubikey outline to saturday, important");
    expect(r.did.map((d: any) => d.ok)).toEqual([true, true, false]);
    const deck = await (await send("GET", "/api/deck")).json();
    const open = deck.areas.flatMap((a: any) => a.items);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ due: "2026-11-21", importance: 3 });
  });

  it("logs spending into Money without unlocking it", async () => {
    const { send } = make();
    await send("PUT", "/api/settings", { llm_url: "http://m/v1", llm_model: "hermes-agent" });
    model([[{ kind: "expense", description: "Camera lens", amount: 420, day: null, direction: "out" }]]);
    const r = await add(send, "log 420 for a camera lens");
    expect(r.did[0]).toMatchObject({ module: "Money", ok: true });
    expect(r.did[0].text).toContain("$420.00");
    expect((await send("GET", "/api/money/summary")).status).toBe(423); // still locked for reading
  });

  it("finds an email by who it's from; replies and hand-offs wait for a tap", async () => {
    const { send, sent } = make();
    await send("PUT", "/api/settings", { mail_user: "ben@example.com", mail_password: "x", llm_url: "http://m/v1", llm_model: "hermes-agent" });
    model([[], // the sync's own sort call is not a filing call; queue starts at the first capture
      ]);
    await send("POST", "/api/inbox/sync");
    const seen = model([
      [{ kind: "email", find: "Dana workshop", do: "reply", say: "april works, hold the room" }],
      [{ kind: "email", find: "acme affiliate", do: "ask", say: "make a note of the affiliate code for a later tutorial" }],
      [{ kind: "email", find: "acme", do: "handoff", say: "can you sort this", to: "Sam" }],
      [{ kind: "email", find: "someone who never wrote", do: "task", say: "x" }],
      [{ kind: "email", find: "acme affiliate", do: "task", say: "sign up for the program by friday" }],
    ]);
    let r = await add(send, "reply to Dana about the workshop: april works, hold the room");
    expect(r.did[0]).toMatchObject({ module: "Inbox", ok: true, detail: "April works. Please hold the room." });
    expect(r.did[0].action).toMatchObject({ label: "Send" });
    expect(sent).toHaveLength(0); // drafted, not sent
    await send("POST", r.did[0].action.path, r.did[0].action.body);
    expect(sent[0]).toMatchObject({ to: "dana@example.org", text: "April works. Please hold the room." });

    r = await add(send, "make a note of the affiliate code in the acme email for a later tutorial");
    expect(r.did[0]).toMatchObject({ module: "Hermes", ok: true });
    await new Promise((x) => setTimeout(x, 20));
    expect(seen.at(-1)!.user).toContain("BEN10"); // the email went with the instruction

    r = await add(send, "forward the acme email to Sam");
    expect(r.did[0]).toMatchObject({ ok: false }); // no address for Sam yet
    r = await add(send, "task from the email from someone who never wrote");
    expect(r.did[0]).toMatchObject({ ok: false });
    r = await add(send, "task from the acme email: sign up by friday");
    expect(r.did[0]).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it("\"People:\" goes straight into People and no model ever sees it", async () => {
    const { send } = make();
    await send("PUT", "/api/settings", { llm_url: "http://m/v1", llm_model: "hermes-agent" });
    const seen = model([]);
    const r = await add(send, "People: Dana said she'd love to co-host in spring");
    expect(r.did[0]).toMatchObject({ module: "People", ok: true });
    expect(r.created).toHaveLength(0);
    expect(seen).toHaveLength(0);
    // And nothing relayed in can use these routes at all.
    model([[{ kind: "expense", description: "x", amount: 5, direction: "out" }]]);
    const { token } = await (await send("POST", "/api/settings/relay-token")).json();
    const relayed = await (await send("POST", "/api/relay/add", { text: "log 5 dollars", source: "claude" }, { authorization: `Bearer ${token}` })).json();
    expect(JSON.stringify(relayed)).not.toContain("Money");
  });
});
