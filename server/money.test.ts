import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { merchantOf, parseAmount, parseDate, parseStatement } from "./money.ts";

const J = { "content-type": "application/json" };

describe("statement reading", () => {
  it("reads dates and amounts in the usual bank shapes", () => {
    expect(parseDate("2026-11-03")).toBe("2026-11-03");
    expect(parseDate("11/03/2026")).toBe("2026-11-03");
    expect(parseDate("25/11/2026")).toBe("2026-11-25");
    expect(parseDate("Nov 3, 2026")).toBe("2026-11-03");
    expect(parseDate("03-Nov-2026")).toBe("2026-11-03");
    expect(parseDate("hello")).toBeNull();
    expect(parseAmount("$1,234.56")).toBe(1234.56);
    expect(parseAmount("(45.00)")).toBe(-45);
    expect(parseAmount("-45.00")).toBe(-45);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("")).toBeNull();
    expect(merchantOf("AMZN Mktp CA*2K4L 800-123-4567")).toBe("Amzn Mktp Ca");
    expect(merchantOf("NETFLIX.COM 866-579-7172")).toBe("Netflix.com");
  });
  it("reads a file with a header and one amount column", () => {
    const { rows, unreadable } = parseStatement('Date,Description,Amount\n2026-11-01,"SAFEWAY #123, CALGARY",-82.14\n2026-11-02,PAYROLL DEPOSIT,3000\nbad,row,x\n');
    expect(rows).toEqual([
      { day: "2026-11-01", description: "SAFEWAY #123, CALGARY", amount: -82.14 },
      { day: "2026-11-02", description: "PAYROLL DEPOSIT", amount: 3000 },
    ]);
    expect(unreadable).toBe(1);
  });
  it("reads debit and credit columns, and a file with no header", () => {
    expect(parseStatement("Transaction Date,Details,Debit,Credit,Balance\n11/05/2026,NETFLIX.COM,20.99,,100\n11/06/2026,E-TRANSFER RECEIVED,,500.00,600\n").rows.map((r) => r.amount)).toEqual([-20.99, 500]);
    expect(parseStatement("11/05/2026,SHELL C01234,60.00,,940.00\n11/06/2026,PAYROLL,,2500.00,3440.00\n").rows).toEqual([
      { day: "2026-11-05", description: "SHELL C01234", amount: -60 },
      { day: "2026-11-06", description: "PAYROLL", amount: 2500 },
    ]);
  });
  it("flips signs for card statements where charges are positive", () => {
    expect(parseStatement("Date,Description,Amount\n2026-11-01,UBER EATS,31.5\n", true).rows[0].amount).toBe(-31.5);
  });
});

describe("money", () => {
  let clock = new Date(2026, 10, 18, 15, 0, 0);
  const make = () => createApp(openDb(":memory:"), () => clock);
  const open = async (app: ReturnType<typeof make>) => {
    const res = await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) });
    return res.headers.get("set-cookie")!.split(";")[0];
  };
  const csv = (lines: string[]) => { const f = new FormData(); f.set("file", new File(["Date,Description,Amount\n" + lines.join("\n")], "s.csv", { type: "text/csv" })); f.set("account", "Chequing"); return f; };

  it("stays shut without the PIN, throttles guesses, and relocks when idle", async () => {
    clock = new Date(2026, 10, 18, 15, 0, 0);
    const app = make();
    expect(await (await app.request("/api/money/status")).json()).toMatchObject({ set: false, open: false });
    expect((await app.request("/api/money/summary")).status).toBe(423);
    expect((await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "12" }) })).status).toBe(400);
    const cookie = await open(app);
    expect((await app.request("/api/money/summary", { headers: { cookie } })).status).toBe(200);
    // Changing the PIN needs the current one.
    expect((await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "111111" }) })).status).toBe(403);
    // Idle for 16 minutes: shut again.
    clock = new Date(2026, 10, 18, 15, 16, 0);
    expect((await app.request("/api/money/summary", { headers: { cookie } })).status).toBe(423);
    for (let i = 0; i < 5; i++) expect((await app.request("/api/money/unlock", { method: "POST", headers: J, body: JSON.stringify({ pin: "000000" }) })).status).toBe(403);
    expect((await app.request("/api/money/unlock", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) })).status).toBe(429);
    clock = new Date(2026, 10, 18, 15, 17, 0);
    const ok = await app.request("/api/money/unlock", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) });
    expect(ok.status).toBe(200);
    const c2 = ok.headers.get("set-cookie")!.split(";")[0];
    await app.request("/api/money/lock", { method: "POST", headers: { cookie: c2 } });
    expect((await app.request("/api/money/summary", { headers: { cookie: c2 } })).status).toBe(423);
    // The stored PIN is a hash, never the digits.
    expect(JSON.stringify(await (await app.request("/api/settings")).json())).not.toContain("246810");
  });

  it("imports, sorts, sums and drills down, skipping repeats", async () => {
    clock = new Date(2026, 10, 18, 15, 0, 0);
    const app = make();
    const cookie = await open(app);
    const h = { cookie };
    const lines = ["2026-11-01,SAFEWAY #123 CALGARY,-82.14", "2026-11-02,PAYROLL DEPOSIT,3000", "2026-11-03,NETFLIX.COM,-20.99", "2026-11-04,AIR CANADA 0142,-640", "2026-11-05,ZZ MYSTERY SHOP,-50", "2026-11-06,TRANSFER TO SAVINGS,-500", "2026-11-07,SAFEWAY #123 CALGARY,-40"];
    const first = await (await app.request("/api/money/import", { method: "POST", headers: h, body: csv(lines) })).json();
    expect(first).toMatchObject({ added: 7, already_there: 0, from: "2026-11-01", to: "2026-11-07" });
    expect(await (await app.request("/api/money/import", { method: "POST", headers: h, body: csv(lines) })).json()).toMatchObject({ added: 0, already_there: 7 });

    const s = await (await app.request("/api/money/summary", { headers: h })).json();
    expect(s.month).toBe("2026-11");
    expect(s.in).toBe(3000);
    expect(s.out).toBeCloseTo(833.13, 2); // the transfer to savings is not spending
    expect(s.left).toBeCloseTo(2166.87, 2);
    expect(s.categories.map((c: any) => c.name)).toEqual(["Travel", "Food", "Other", "Subscriptions"]);
    expect(s.categories[1].merchants[0]).toMatchObject({ name: "Safeway Calgary", count: 2 });
    expect(s.unsorted).toBe(1);

    const other = await (await app.request("/api/money/tx?month=2026-11&category=Other", { headers: h })).json();
    await app.request(`/api/money/tx/${other.tx[0].id}`, { method: "PATCH", headers: { ...h, ...J }, body: JSON.stringify({ category: "Shopping", always: true }) });
    // The rule applies to later imports too.
    await app.request("/api/money/import", { method: "POST", headers: h, body: csv(["2026-11-09,ZZ MYSTERY SHOP,-12"]) });
    const shop = await (await app.request("/api/money/tx?month=2026-11&category=Shopping", { headers: h })).json();
    expect(shop.tx).toHaveLength(2);

    await app.request("/api/money/tx", { method: "POST", headers: { ...h, ...J }, body: JSON.stringify({ amount: "45", description: "Coffee beans", day: "2026-11-10" }) });
    expect((await (await app.request("/api/money/summary", { headers: h })).json()).count).toBe(9);
    expect((await app.request("/api/money/import", { method: "POST", headers: h, body: (() => { const f = new FormData(); f.set("file", new File(["x"], "s.pdf")); return f; })() })).status).toBe(400);
  });

  it("reads a PDF statement on the Umbrel, saves nothing until the rows are sent back, and skips repeats", async () => {
    clock = new Date(2026, 10, 19, 15, 0, 0);
    const app = make();
    const h = { cookie: await open(app) };
    const { readFileSync } = await import("node:fs");
    const pdf = () => { const f = new FormData(); f.set("file", new File([readFileSync(new URL("./fixtures/card.pdf", import.meta.url))], "visa-nov.pdf", { type: "application/pdf" })); return f; };
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response("{}"); }) as typeof fetch;
    try {
      expect((await app.request("/api/money/read-pdf", { method: "POST", body: pdf() })).status).toBe(423); // locked without the PIN
      const read = await (await app.request("/api/money/read-pdf", { method: "POST", headers: h, body: pdf() })).json();
      expect(read).toMatchObject({ name: "visa-nov.pdf", via: "here", layout: "card", can_use_model: false });
      expect(read.rows).toHaveLength(4);
      expect(called).toBe(0); // no model, no network
      expect((await (await app.request("/api/money/summary?month=2026-11", { headers: h })).json()).out).toBe(0); // nothing saved yet
      const save = (rows: unknown) => app.request("/api/money/import-rows", { method: "POST", headers: { ...h, ...J }, body: JSON.stringify({ rows, account: "Visa" }) });
      expect(await (await save(read.rows)).json()).toMatchObject({ added: 4, already_there: 0 });
      expect(await (await save(read.rows)).json()).toMatchObject({ added: 0, already_there: 4 });
      expect((await save([{ day: "nonsense", description: "x", amount: 1 }])).status).toBe(400);
      const junk = new FormData(); junk.set("file", new File(["not a pdf"], "x.pdf"));
      expect((await app.request("/api/money/read-pdf", { method: "POST", headers: h, body: junk })).status).toBe(400);
    } finally { globalThis.fetch = real; }
  });

  it("spots repeating charges, a price rise and a double charge", async () => {
    clock = new Date(2026, 10, 18, 15, 0, 0);
    const app = make();
    const h = { cookie: await open(app) };
    await app.request("/api/money/import", { method: "POST", headers: h, body: csv([
      "2026-09-03,NETFLIX.COM,-16.99", "2026-10-03,NETFLIX.COM,-16.99", "2026-11-03,NETFLIX.COM,-20.99",
      "2026-09-05,SPOTIFY,-11", "2026-10-05,SPOTIFY,-11", "2026-11-05,SPOTIFY,-11",
      "2026-11-08,PUB 99,-30", "2026-11-08,PUB 99 ,-30",
    ]) });
    const s = await (await app.request("/api/money/summary?month=2026-11", { headers: h })).json();
    expect(s.savings[0].text).toMatch(/^2 charges repeat every month: Netflix.com, Spotify/);
    expect(s.savings[0].amount).toBeCloseTo(31.99, 2);
    expect(s.savings.some((x: any) => /Netflix.com costs more/.test(x.text))).toBe(true);
    expect(s.savings.some((x: any) => /Pub charged the same amount twice/.test(x.text))).toBe(true);
    expect(s.previous).toMatchObject({ month: "2026-10" });
  });

  it("sends only merchant names to Money's model", async () => {
    const app = make();
    const h = { cookie: await open(app) };
    await app.request("/api/money/import", { method: "POST", headers: h, body: csv(["2026-11-05,ZZ MYSTERY SHOP,-50.55"]) });
    expect((await app.request("/api/money/sort", { method: "POST", headers: h })).status).toBe(400);
    await app.request("/api/settings", { method: "PUT", headers: J, body: JSON.stringify({ money_llm_url: "http://m/v1", money_llm_model: "deepseek" }) });
    const real = globalThis.fetch;
    let sent = "";
    globalThis.fetch = (async (_u: any, init: any) => { sent = init.body; return new Response(JSON.stringify({ choices: [{ message: { content: '{"Zz Mystery Shop":"Shopping"}' } }] })); }) as typeof fetch;
    try {
      expect(await (await app.request("/api/money/sort", { method: "POST", headers: h })).json()).toEqual({ sorted: 1 });
      expect(sent).toContain("Zz Mystery Shop");
      expect(sent).not.toContain("50.55");
      expect(sent).not.toContain("2026-11-05");
    } finally { globalThis.fetch = real; }
  });
});
