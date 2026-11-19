import { describe, expect, it } from "vitest";
import { openDb, type Task } from "./db.ts";
import { rank } from "./rank.ts";
import { fileByRules, fileCapture, parseDue, parseMinutes } from "./file.ts";
import { createApp } from "./app.ts";

const DAY = "2026-11-18"; // a Wednesday

function task(p: Partial<Task>): Task {
  return {
    id: 1, area_id: "work", title: "t", note: null, importance: 2, due: null, minutes: null,
    status: "open", delegate: null, snoozed_until: null, source: "app", created_at: DAY, done_at: null, ...p,
  };
}

describe("ranking", () => {
  it("puts high importance due soon ahead of medium due later", () => {
    const r = rank([
      task({ id: 1, importance: 2, due: "2026-11-25" }),
      task({ id: 2, importance: 3, due: "2026-11-19", minutes: 90 }),
    ], DAY);
    expect(r.map((x) => x.task.id)).toEqual([2, 1]);
    expect(r[0].why).toEqual(["High importance", "Due tomorrow", "About 1.5 hr"]);
  });
  it("lets an overdue medium task beat an undated high one", () => {
    const r = rank([task({ id: 1, importance: 3 }), task({ id: 2, importance: 2, due: "2026-11-16" })], DAY);
    expect(r[0].task.id).toBe(2);
  });
  it("leaves out delegated, done and snoozed tasks", () => {
    const r = rank([
      task({ id: 1, delegate: "Nathan" }),
      task({ id: 2, status: "done" }),
      task({ id: 3, snoozed_until: "2026-11-19" }),
      task({ id: 4, snoozed_until: DAY }),
    ], DAY);
    expect(r.map((x) => x.task.id)).toEqual([4]);
  });
});

describe("quick-add rules", () => {
  it("reads dates", () => {
    expect(parseDue("by Friday", DAY)).toBe("2026-11-20");
    expect(parseDue("tomorrow morning", DAY)).toBe("2026-11-19");
    expect(parseDue("on Wednesday", DAY)).toBe("2026-11-25");
    expect(parseDue("no date here", DAY)).toBeNull();
  });
  it("reads time needed", () => {
    expect(parseMinutes("should take 90 minutes")).toBe(90);
    expect(parseMinutes("about 1.5 hours")).toBe(90);
    expect(parseMinutes("no time")).toBeNull();
  });
  it("splits a spoken note into filed tasks", () => {
    const out = fileByRules(
      "Finish the YubiKey outline by Thursday, it's important, about 90 minutes. Book the Costa Rica flights. I want to try a dance class this week.",
      DAY,
    );
    expect(out.map((o) => o.area)).toEqual(["work", "travel", "hobbies"]);
    expect(out[0]).toMatchObject({ importance: 3, due: "2026-11-19", minutes: 90 });
    expect(out[1].title).toBe("Book the Costa Rica flights");
    expect(out[0].title).toBe("Finish the YubiKey outline");
    expect(out[2].title).toBe("Try a dance class");
  });
  it("keeps a link as the note and reads a hand-off", () => {
    const [a] = fileByRules("Ask Nathan to redo the thumbnail https://example.com/brief", DAY);
    expect(a.delegate).toBe("Nathan");
    expect(a.note).toBe("https://example.com/brief");
    expect(a.title).toBe("Ask Nathan to redo the thumbnail");
    expect(fileByRules("Get Costa Rica flights booked", DAY)[0].delegate).toBeNull();
    expect(fileByRules("Have Daniel cut the intro", DAY)[0].delegate).toBe("Daniel");
  });
  it("never files into People", () => {
    expect(fileByRules("Call her back about dinner", DAY)[0].area).not.toBe("people");
  });
});

describe("model filing", () => {
  const cfg = { url: "http://model/v1", model: "m" };
  it("uses the model's answer when it is valid", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Sure: [{"area":"travel","title":"Book flights","importance":3,"due":"2026-11-20","minutes":20,"delegate":null,"note":null}]' } }] }))) as typeof fetch;
    const r = await fileCapture("book flights", DAY, cfg, fake);
    expect(r.via).toBe("model");
    expect(r.items[0]).toMatchObject({ area: "travel", importance: 3, due: "2026-11-20" });
  });
  it("falls back to rules when the model fails or returns junk", async () => {
    const down = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const junk = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "I can't" } }] }))) as typeof fetch;
    expect((await fileCapture("Book the flights", DAY, cfg, down)).via).toBe("rules");
    expect((await fileCapture("Book the flights", DAY, cfg, junk)).via).toBe("rules");
  });
  it("won't let the model file into People or invent an area", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '[{"area":"people","title":"x"},{"area":"nope","title":"y"}]' } }] }))) as typeof fetch;
    const r = await fileCapture("x", DAY, cfg, fake);
    expect(r.items.map((i) => i.area)).toEqual(["work", "work"]);
  });
});

describe("api", () => {
  const make = () => createApp(openDb(":memory:"), () => new Date(2026, 10, 18, 15, 0, 0));
  const post = (app: ReturnType<typeof make>, path: string, body: unknown, method = "POST") =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("captures, ranks, completes and snoozes", async () => {
    const app = make();
    const cap = await (await post(app, "/api/capture", {
      text: "Answer the speaking invite by Friday, 10 minutes, important. Book Costa Rica flights next week.",
    })).json();
    expect(cap.created).toHaveLength(2);
    expect(cap.created[1].area_name).toBe("Travel & Speaking");

    let deck = await (await app.request("/api/deck")).json();
    expect(deck.today).toBe(DAY);
    expect(deck.next[0].title).toBe("Answer the speaking invite");
    // Both land in Travel & Speaking: a speaking invite and a flight.
    expect(deck.areas.find((a: any) => a.id === "travel").need).toBe(2);

    await post(app, `/api/tasks/${deck.next[0].id}`, { status: "done" }, "PATCH");
    deck = await (await app.request("/api/deck")).json();
    expect(deck.next[0].title).toBe("Book Costa Rica flights");

    await post(app, `/api/tasks/${deck.next[0].id}`, { snooze: true }, "PATCH");
    deck = await (await app.request("/api/deck")).json();
    expect(deck.next).toHaveLength(0);
    // Snoozed tasks still sit in their module, just not as "needs you".
    expect(deck.areas.find((a: any) => a.id === "travel").items[0].needs_you).toBe(false);
  });

  it("shows Money task titles but never People task text", async () => {
    const db = openDb(":memory:");
    const app = createApp(db, () => new Date(2026, 10, 18, 15, 0, 0));
    await post(app, "/api/capture", { text: "Upload the bank statement today, urgent" });
    db.prepare("INSERT INTO tasks (area_id, title, importance, due, created_at) VALUES ('people', 'private thing', 3, ?, ?)").run(DAY, DAY);
    const deck = await (await app.request("/api/deck")).json();
    expect(deck.areas.find((a: any) => a.id === "money").items[0].title).toBe("Upload the bank statement");
    expect(deck.areas.find((a: any) => a.id === "people")).toMatchObject({ locked: true, need: 1, items: [] });
    expect(JSON.stringify(deck)).not.toContain("private thing");
    expect(deck.next.find((n: any) => n.locked)).toMatchObject({ title: "People: something due", why: [] });
  });

  it("saves settings, never returns keys, and uses the saved model for filing", async () => {
    const app = make();
    expect((await post(app, "/api/settings", { llm_url: "ftp://x" }, "PUT")).status).toBe(400);
    const saved = await (await post(app, "/api/settings", { llm_url: "http://model/v1/", llm_model: "m", llm_key: "secret" }, "PUT")).json();
    expect(saved).toMatchObject({ llm_url: "http://model/v1/", llm_model: "m", llm_key_set: true, stt_key_set: false });
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect((await (await app.request("/api/config")).json()).model).toBe("m");

    const real = globalThis.fetch;
    const seen: any[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push([String(url), init.headers.authorization]);
      return new Response(JSON.stringify({ choices: [{ message: { content: '[{"area":"health","title":"Book physio","importance":2}]' } }] }));
    }) as typeof fetch;
    try {
      const cap = await (await post(app, "/api/capture", { text: "book physio" })).json();
      expect(cap.via).toBe("model");
      expect(cap.created[0].area_id).toBe("health");
      expect(seen[0]).toEqual(["http://model/v1/chat/completions", "Bearer secret"]);
      expect(await (await app.request("/api/settings/test", { method: "POST" })).json()).toMatchObject({ ok: true });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("rejects bad input with a plain message", async () => {
    const app = make();
    expect((await post(app, "/api/capture", { text: "  " })).status).toBe(400);
    await post(app, "/api/capture", { text: "Do a thing" });
    expect((await post(app, "/api/tasks/1", { due: "friday" }, "PATCH")).status).toBe(400);
    expect((await post(app, "/api/tasks/1", { importance: 9 }, "PATCH")).status).toBe(400);
    expect((await post(app, "/api/tasks/99", { status: "done" }, "PATCH")).status).toBe(404);
    expect((await app.request("/api/transcribe", { method: "POST" })).status).toBe(501);
  });
});
