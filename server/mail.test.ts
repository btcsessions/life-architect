import { describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import type { InMail, OutMail } from "./mail.ts";

const J = { "content-type": "application/json" };
const mail = (n: number, from: string, subject: string, extra: Partial<InMail> = {}): InMail => ({ uid: n, message_id: `<m${n}@x>`, from_name: from.split("@")[0], from_addr: from, subject, date: `2026-11-18T1${n % 10}:00:00.000Z`, text: `Body of ${subject}`, references: "", bulk: false, ...extra });
function make(inbox: InMail[]) {
  const sent: OutMail[] = [];
  const state = { fail: false };
  const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 18, 15, 0, 0), { mail: () => ({ recent: async () => inbox, send: async (m) => { if (state.fail) throw new Error("smtp down"); sent.push(m); } }) });
  const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: J, body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, sent, send, state };
}
afterEach(() => vi.unstubAllGlobals());

describe("inbox", () => {
  it("needs Gmail details before it does anything", async () => {
    const { send } = make([]);
    expect((await (await send("GET", "/api/inbox")).json()).connected).toBe(false);
    expect((await send("POST", "/api/inbox/sync")).status).toBe(400);
  });

  it("sorts without a model, replies only on Send, and learns hand-offs", async () => {
    const inbox = [mail(1, "client@acme.com", "Sponsorship question"), mail(2, "noreply@shop.com", "Your receipt"), mail(3, "list@news.org", "Weekly", { bulk: true })];
    const { send, sent, state } = make(inbox);
    await send("PUT", "/api/settings", { mail_user: "ben@example.com", mail_password: "abcd efgh ijkl mnop", mail_from_name: "Ben" });
    expect(await (await send("POST", "/api/inbox/sync")).json()).toEqual({ added: 3, auto: 0 });
    expect(await (await send("POST", "/api/inbox/sync")).json()).toEqual({ added: 0, auto: 0 }); // no duplicates
    let box = await (await send("GET", "/api/inbox")).json();
    expect(box.unsure.map((m: any) => m.subject)).toEqual(["Sponsorship question"]);
    expect(box.fyi).toHaveLength(2);
    const id = box.unsure[0].id;

    // The deck badge counts mail waiting on him, never the noise.
    const deck = await (await send("GET", "/api/deck")).json();
    expect(deck.areas.find((a: any) => a.id === "inbox").need).toBe(1);

    // Drafting sends nothing.
    const draft = await (await send("POST", `/api/inbox/${id}/draft`, { say: "Yes, send the deck." })).json();
    expect(draft).toMatchObject({ subject: "Re: Sponsorship question", text: "Yes, send the deck.", via: "your words" });
    expect(sent).toHaveLength(0);
    expect((await send("POST", `/api/inbox/${id}/send`, { text: "ok", cc: "not an address" })).status).toBe(400);

    // A failed send marks nothing.
    state.fail = true;
    expect((await send("POST", `/api/inbox/${id}/send`, { text: "Yes." })).status).toBe(502);
    expect((await (await send("GET", "/api/inbox")).json()).unsure).toHaveLength(1);
    state.fail = false;

    await send("POST", `/api/inbox/${id}/send`, { text: "Yes, send it.", cc: "sam@example.com", forward_to: "files@example.com" });
    expect(sent[0]).toMatchObject({ to: "client@acme.com", cc: "sam@example.com", subject: "Re: Sponsorship question", in_reply_to: "<m1@x>" });
    expect(sent[1]).toMatchObject({ to: "files@example.com", subject: "Fwd: Sponsorship question" });
    box = await (await send("GET", "/api/inbox")).json();
    expect(box.unsure).toHaveLength(0);
    expect(box.handled[0].handled_how).toBe("Replied");
  });

  it("hands off by email, remembers who gets what, and only auto-sends when switched on after three", async () => {
    const inbox: InMail[] = [mail(1, "booker@conf.io", "Speaking slot")];
    const { send, sent } = make(inbox);
    await send("PUT", "/api/settings", { mail_user: "ben@example.com", mail_password: "x" });
    const hand = async () => {
      await send("POST", "/api/inbox/sync");
      const box = await (await send("GET", "/api/inbox")).json();
      return [...box.unsure, ...box.handoff][0];
    };
    let m = await hand();
    expect((await send("POST", `/api/inbox/${m.id}/handoff`, { name: "Sam", email: "nope" })).status).toBe(400);
    await send("POST", `/api/inbox/${m.id}/handoff`, { name: "Sam", email: "sam@example.com", note: "Please book this." });
    expect(sent[0]).toMatchObject({ to: "sam@example.com", subject: "Fwd: Speaking slot" });
    expect(sent[0].text).toContain("Please book this.");
    // It lands on the deck as handed off.
    const deck = await (await send("GET", "/api/deck")).json();
    expect(deck.areas.find((a: any) => a.id === "inbox").items[0]).toMatchObject({ delegate: "Sam" });

    // Next one from the same sender is suggested, not sent.
    inbox.push(mail(2, "booker@conf.io", "Second slot"));
    m = await hand();
    expect(m).toMatchObject({ bucket: "handoff", suggest_name: "Sam", suggest_email: "sam@example.com" });
    expect(sent).toHaveLength(1);
    await send("POST", `/api/inbox/${m.id}/handoff`, { name: "Sam", email: "sam@example.com" });
    inbox.push(mail(3, "booker@conf.io", "Third slot"));
    m = await hand();
    await send("POST", `/api/inbox/${m.id}/handoff`, { name: "Sam", email: "sam@example.com" });
    expect(sent).toHaveLength(3);

    // Three confirmations, but auto is off: still only a suggestion, and Noticed points it out.
    inbox.push(mail(4, "booker@conf.io", "Fourth slot"));
    m = await hand();
    expect(sent).toHaveLength(3);
    const noticed = await (await send("GET", "/api/noticed")).json();
    expect(noticed.suggestions[0].text).toContain("booker@conf.io");

    // Switched on: the next one goes by itself and says so.
    await send("PUT", "/api/settings", { mail_auto_delegate: "on" });
    inbox.push(mail(5, "booker@conf.io", "Fifth slot"));
    expect(await (await send("POST", "/api/inbox/sync")).json()).toEqual({ added: 1, auto: 1 });
    expect(sent[3]).toMatchObject({ to: "sam@example.com", subject: "Fwd: Fifth slot" });
    const sum = await (await send("GET", "/api/inbox-summary")).json();
    expect(sum.text).toContain('"Fifth slot" to Sam (automatic)');
  });

  it("uses the model to sort and draft, and won't hand off to a name it made up", async () => {
    const inbox = [mail(1, "a@one.com", "Invoice query"), mail(2, "b@two.com", "Podcast invite")];
    const { send } = make(inbox);
    await send("PUT", "/api/settings", { mail_user: "ben@example.com", mail_password: "x", llm_url: "http://model/v1", llm_model: "m" });
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
      const sys = JSON.parse(init.body).messages[0].content as string;
      const content = sys.includes("sort one person's email")
        ? JSON.stringify([{ n: 1, bucket: "handoff", summary: "Asks about an invoice.", to: "Nobody Real" }, { n: 2, bucket: "you", summary: "Wants you on a podcast.", to: null }])
        : "Happy to. How is next Tuesday?";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }));
    await send("POST", "/api/inbox/sync");
    const box = await (await send("GET", "/api/inbox")).json();
    expect(box.you[0]).toMatchObject({ subject: "Podcast invite", summary: "Wants you on a podcast." });
    expect(box.unsure[0]).toMatchObject({ subject: "Invoice query", suggest_name: null });
    const draft = await (await send("POST", `/api/inbox/${box.you[0].id}/draft`, { say: "yes, tuesday" })).json();
    expect(draft).toMatchObject({ via: "model", text: "Happy to. How is next Tuesday?" });
  });
});

describe("noticed", () => {
  it("spots repeats and turns a yes into a Build task", async () => {
    const { send } = make([]);
    for (let i = 0; i < 3; i++) await send("POST", "/api/capture", { text: "Send the weekly invoice" });
    const { suggestions } = await (await send("GET", "/api/noticed")).json();
    expect(suggestions).toHaveLength(1);
    await send("POST", "/api/noticed", { key: suggestions[0].key, answer: "yes" });
    expect((await (await send("GET", "/api/noticed")).json()).suggestions).toHaveLength(0);
    const deck = await (await send("GET", "/api/deck")).json();
    expect(deck.areas.find((a: any) => a.id === "build").items[0].title).toContain("repeat on its own");
  });
});
