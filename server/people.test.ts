import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { chunkMarkdown, quotesIn, retrieve } from "./people.ts";

const J = { "content-type": "application/json" };

describe("people helpers", () => {
  it("keeps quoted words verbatim", () => {
    expect(quotesIn('She said “maybe next week” and then "I\'ll think about it".')).toEqual(["maybe next week", "I'll think about it"]);
    expect(quotesIn("she seemed tense")).toEqual([]);
  });
  it("splits a library file by heading and retrieves only what's relevant", () => {
    const chunks = chunkMarkdown("# Asking plainly\nState the ask once, with a time. Do not hedge the ask.\n\n## Listening\nReflect what she said before answering.\n");
    expect(chunks.map((c) => c.heading)).toEqual(["Asking plainly", "Listening"]);
    expect(retrieve(chunks, "I keep hedging the ask and never state a time")[0].heading).toBe("Asking plainly");
    expect(retrieve(chunks, "what should we cook tonight")).toEqual([]);
  });
});

describe("people", () => {
  const setup = async () => {
    const core = openDb(":memory:");
    const app = createApp(core, () => new Date(2026, 10, 18, 15, 0, 0));
    const res = await app.request("/api/people/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "135790" }) });
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const h = { cookie, ...J };
    const send = async (method: string, path: string, body?: unknown) => app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { app, core, h, send, json: async (method: string, path: string, body?: unknown) => (await send(method, path, body)).json() };
  };
  const model = (app: any, answer: unknown, seen?: string[]) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => { seen?.push(String(url) + "\n" + init.body); return new Response(JSON.stringify({ choices: [{ message: { content: typeof answer === "string" ? answer : JSON.stringify(answer) } }] })); }) as typeof fetch;
    return () => { globalThis.fetch = real; };
  };

  it("is shut without its PIN and shows nothing on the deck", async () => {
    const { app, json } = await setup();
    expect((await app.request("/api/people/home")).status).toBe(423);
    const p = await json("POST", "/api/people/persons", { name: "Sample Person", how_met: "Bookshop", building_toward: "A steady friendship" });
    const home = await json("GET", "/api/people/home");
    await json("PATCH", `/api/people/goals/${home.relationships[0].id}`, { next_action: "Suggest coffee", next_due: "2026-11-20" });
    const deck = await (await app.request("/api/deck")).json();
    const tile = deck.areas.find((a: any) => a.id === "people");
    expect(tile).toMatchObject({ locked: true, need: 1, items: [] });
    expect(JSON.stringify(deck)).not.toMatch(/Suggest coffee|Sample Person|friendship/);
    expect(p.name).toBe("Sample Person");
  });

  it("insists on a dated next move, keeps steps in order, and never rewrites the record", async () => {
    const { json, send } = await setup();
    const a = await json("POST", "/api/people/persons", { name: "Alex", building_toward: "Closer" });
    const g = (await json("GET", "/api/people/home")).relationships[0];
    expect((await send("PATCH", `/api/people/goals/${g.id}`, { next_action: "Talk at some point" })).status).toBe(400);
    expect((await json("PATCH", `/api/people/goals/${g.id}`, { next_action: "Re-ask about the weekend" })).next_action).toMatch(/Re-ask/);
    expect((await json("PATCH", `/api/people/goals/${g.id}`, { next_action: "One conversation", next_due: "2026-11-21" })).next_due).toBe("2026-11-21");

    const s = await json("POST", "/api/people/goals", { kind: "scenario", title: "Host a dinner for six", done_looks_like: "Six people at the table", people: [a.id], steps: ["Pick a date", "Invite", "Cook"] });
    expect(s).toMatchObject({ step_number: 1, people: [{ name: "Alex" }] });
    expect((await send("POST", `/api/people/steps/${s.steps[1].id}/done`)).status).toBe(400);
    expect((await json("POST", `/api/people/steps/${s.steps[0].id}/done`)).step_number).toBe(2);

    await json("POST", "/api/people/interactions", { person_id: a.id, goal_id: s.id, text: 'Asked about Saturday. She said "let me check with work".', outcome: "hook" });
    const prof = await json("GET", `/api/people/persons/${a.id}`);
    expect(prof.quotes[0]).toMatchObject({ text: "let me check with work", grade: "O:ben" });
    expect(prof.log[0]).toMatchObject({ outcome: "hook", kind: "note" });
    expect(prof.days_quiet).toBe(0);
    await json("POST", "/api/people/threads", { person_id: a.id, question: "Is Saturday on?" });
    await json("POST", "/api/people/facts", { person_id: a.id, label: "Likes", value: "Quiet places", grade: "O:inf" });
    const p2 = await json("GET", `/api/people/persons/${a.id}`);
    expect(p2.threads).toHaveLength(1);
    expect(p2.facts[0].grade).toBe("O:inf");
    await json("POST", `/api/people/facts/${p2.facts[0].id}/confirm`);
    expect((await json("GET", `/api/people/persons/${a.id}`)).facts[0].grade).toBe("O:ben");
  });

  it("takes hand-offs from Hermes without ever answering with People data", async () => {
    const { app, json } = await setup();
    const { token } = await (await app.request("/api/settings/relay-token", { method: "POST" })).json();
    expect((await app.request("/api/people-drop", { method: "POST", headers: J, body: JSON.stringify({ text: "x" }) })).status).toBe(401);
    const res = await app.request("/api/people-drop", { method: "POST", headers: { ...J, authorization: `Bearer ${token}` }, body: JSON.stringify({ items: ["Old conversation one", "Old conversation two"], source: "hermes" }) });
    expect(await res.json()).toEqual({ received: 2, filed: 0, unsorted: 2, people_created: 0, duplicates: 0 });
    // The relay itself still can't read anything about People.
    expect((await app.request("/api/people/inbox", { headers: { authorization: `Bearer ${token}` } })).status).toBe(423);
    const a = await json("POST", "/api/people/persons", { name: "Alex" });
    const inbox = await json("GET", "/api/people/inbox");
    expect(inbox.items).toHaveLength(2);
    await json("POST", "/api/people/interactions", { person_id: a.id, text: inbox.items[0].text, inbox_id: inbox.items[0].id });
    await json("POST", `/api/people/inbox/${inbox.items[1].id}/skip`);
    expect((await json("GET", "/api/people/home")).inbox).toBe(0);
  });

  it("files a named, dated hand-over straight onto people, once, and lets you merge or remove them after", async () => {
    const { app, json, send } = await setup();
    const { token } = await (await app.request("/api/settings/relay-token", { method: "POST" })).json();
    const drop = async (items: unknown[]) => (await app.request("/api/people-drop", { method: "POST", headers: { ...J, authorization: `Bearer ${token}` }, body: JSON.stringify({ items, source: "hermes" }) })).json();
    const dump = [
      { person: "Dana Lee", date: "2026-09-02", text: 'First call. She said "send me the outline".', outcome: "hook" },
      { person: "Dana Lee", date: "2026-10-15", text: "Coffee, talked dates." },
      { person: "dana lee", type: "fact", label: "Does", text: "Runs a conference" },
      { person: "Dana Lee", type: "question", text: "Which month works?" },
      { person: "Dana Lee", type: "goal", text: "Co-host a workshop" },
      { person: "Dana", date: "2026-08-01", text: "Met at the meetup." },
      { person: "Mistake", text: "Not a real person." },
      "Something with no name on it",
    ];
    const first = await drop(dump);
    expect(first).toEqual({ received: 8, filed: 7, unsorted: 1, people_created: 3, duplicates: 0 });
    expect(JSON.stringify(first)).not.toContain("Dana"); // counts only
    expect(await drop(dump)).toMatchObject({ filed: 0, duplicates: 8 }); // running it twice is safe

    let home = await json("GET", "/api/people/home");
    expect(home.relationships.map((g: any) => g.title)).toEqual(["Co-host a workshop"]);
    expect(home.unplaced.map((p: any) => p.name).sort()).toEqual(["Dana", "Mistake"]);
    const lee = home.people.find((p: any) => p.name === "Dana Lee"), dana = home.people.find((p: any) => p.name === "Dana"), oops = home.people.find((p: any) => p.name === "Mistake");
    let view = await json("GET", `/api/people/persons/${lee.id}`);
    expect(view.log.map((i: any) => i.ts.slice(0, 10))).toEqual(["2026-10-15", "2026-09-02"]); // their real dates, newest first
    expect(view.quotes[0].text).toBe("send me the outline");
    expect(view.facts[0]).toMatchObject({ label: "Does", grade: "O:sys" });
    expect(view.threads).toHaveLength(1);

    // "Dana" and "Dana Lee" are the same person.
    await json("POST", `/api/people/persons/${dana.id}/merge`, { into: lee.id });
    view = await json("GET", `/api/people/persons/${lee.id}`);
    expect(view.log).toHaveLength(3);
    expect((await send("GET", `/api/people/persons/${dana.id}`)).status).toBe(404);
    // The words of a filed note still can't be changed.
    await json("DELETE", `/api/people/persons/${oops.id}`);
    home = await json("GET", "/api/people/home");
    expect(home.people.map((p: any) => p.name)).toEqual(["Dana Lee"]);
    expect(home.unplaced).toHaveLength(0);
  });

  it("files what you tell it, only under people it knows, using People's own model", async () => {
    const { app, json, send } = await setup();
    await json("POST", "/api/people/persons", { name: "Alex" });
    expect((await send("POST", "/api/people/tell", { text: "hi" })).status).toBe(400); // no model set
    await app.request("/api/settings", { method: "PUT", headers: J, body: JSON.stringify({ llm_url: "http://deck/v1", llm_model: "opus", people_llm_url: "http://maple/v1", people_llm_model: "deepseek" }) });
    const seen: string[] = [];
    const restore = model(app, { reply: "Filed under Alex. Who is Jordan?", actions: [
      { type: "note", person: "Alex", text: 'Coffee went well. She said "same time next week?"', outcome: "close" },
      { type: "note", person: "Jordan", text: "should not be filed" },
      { type: "fact", person: "Alex", label: "Likes", value: "Flat whites", guess: true },
    ] }, seen);
    try {
      const r = await json("POST", "/api/people/tell", { text: "Coffee with Alex went well, and Jordan was there" });
      expect(r.reply).toMatch(/Who is Jordan/);
      expect(r.did).toEqual(["Note filed under Alex", "Guess added for Alex"]);
      expect(seen[0]).toMatch(/^http:\/\/maple\/v1\/chat\/completions/); // never the deck's model
      expect(seen[0]).toContain('Known people: [\\"Alex\\"]');
    } finally { restore(); }
    const home = await json("GET", "/api/people/home");
    expect(home.people).toHaveLength(1);
    expect((await json("GET", "/api/people/chat")).messages).toHaveLength(2);
  });

  it("produces a graded reading with a real citation, and won't accept it ungraded", async () => {
    const { app, json, send, h } = await setup();
    const a = await json("POST", "/api/people/persons", { name: "Alex", building_toward: "Closer" });
    await json("POST", "/api/people/interactions", { person_id: a.id, text: 'I kept hedging the ask. She said "just say what you want".' });
    const form = new FormData();
    form.set("file", new File(["# Asking plainly\nState the ask once, with a time. Do not hedge the ask.\n"], "asking.md", { type: "text/markdown" }));
    expect(await (await app.request("/api/people/library", { method: "POST", headers: { cookie: h.cookie }, body: form })).json()).toEqual({ files: 1, passages: 1 });
    await app.request("/api/settings", { method: "PUT", headers: J, body: JSON.stringify({ people_llm_url: "http://maple/v1", people_llm_model: "deepseek" }) });
    const seen: string[] = [];
    const restore = model(app, {
      what_happened: ["You hedged the ask.", 'She said "just say what you want".'],
      readings: [{ text: "She wants a plain ask.", grade: "O", wrong_if: "She deflects a plain ask too." }, { text: "You talk too long before asking.", wrong_if: "Short asks also stall." }],
      change_my_mind: "If a plain ask is also met with deflection.", brakes: "It was late and she was tired.",
      next_action: { what: "Ask plainly for Saturday dinner", when: "2026-11-20" },
      words: { text: "State the ask once, with a time.", source: 1 }, no_quotes: false,
    }, seen);
    let id: number;
    try { id = (await json("POST", "/api/people/readings", { person_id: a.id })).id; } finally { restore(); }
    expect(seen[0]).toContain("Library passages:\\n[1] Asking plainly");
    const r = await json("GET", `/api/people/readings/${id}`);
    expect(r.body.readings.map((x: any) => x.grade)).toEqual(["O", null]);
    expect(r.body.words.source).toBe(1);
    expect(r.manifest).toMatchObject({ notes: 1, person: "Alex", passages: [{ id: 1, title: "asking.md › Asking plainly" }] });
    expect((await send("PATCH", `/api/people/readings/${id}`, { accept: true })).status).toBe(400);
    await json("PATCH", `/api/people/readings/${id}`, { grade: { index: 1, value: "F" } });
    expect((await json("PATCH", `/api/people/readings/${id}`, { accept: true })).accepted).toBe(true);
    const home = await json("GET", "/api/people/home");
    expect(home.next).toMatchObject({ action: "Ask plainly for Saturday dinner", due: "2026-11-20", for: "Alex" });
  });

  it("drops a citation the model made up", async () => {
    const { app, json } = await setup();
    const a = await json("POST", "/api/people/persons", { name: "Alex" });
    await json("POST", "/api/people/interactions", { person_id: a.id, text: "We talked." });
    await app.request("/api/settings", { method: "PUT", headers: J, body: JSON.stringify({ people_llm_url: "http://maple/v1", people_llm_model: "deepseek" }) });
    const restore = model(app, { what_happened: ["You talked."], readings: [{ text: "x", grade: "?", wrong_if: "y" }], change_my_mind: "", brakes: "", next_action: { what: "Ask", when: "next time you speak" }, words: { text: "invented", source: 99 }, no_quotes: true });
    try {
      const { id } = await json("POST", "/api/people/readings", { person_id: a.id });
      expect((await json("GET", `/api/people/readings/${id}`)).body.words).toBeNull();
    } finally { restore(); }
  });
});
