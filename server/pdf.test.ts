import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pdfLines, readStatement } from "./pdf.ts";

const read = async (name: string, today = "2026-11-19") => readStatement(await pdfLines(new Uint8Array(readFileSync(new URL(`./fixtures/${name}.pdf`, import.meta.url)))), today);

describe("PDF statements", () => {
  it("reads a chequing statement with withdrawal and deposit columns", async () => {
    const r = await read("chequing");
    expect(r.layout).toBe("columns");
    expect(r.rows).toEqual([
      { day: "2026-10-02", description: "Interac purchase SAFEWAY #8812", amount: -84.17 },
      { day: "2026-10-05", description: "Payroll deposit ACME MEDIA", amount: 3250 },
      { day: "2026-10-09", description: "Pre-authorized debit ENMAX", amount: -212.4 },
      { day: "2026-10-28", description: "e-Transfer sent J SMITH", amount: -1500 },
    ]);
  });

  it("works out direction from the running balance, and the year across December into January", async () => {
    const r = await read("savings");
    expect(r.layout).toBe("balance");
    expect(r.rows).toEqual([
      { day: "2025-12-18", description: "POS NETFLIX.COM", amount: -20.99 },
      { day: "2025-12-31", description: "Transfer in from savings", amount: 300 },
      { day: "2026-01-03", description: "ATM withdrawal", amount: -60 },
    ]);
  });

  it("reads a card statement: spending is out, payments and refunds are in, totals are ignored", async () => {
    const r = await read("card");
    expect(r.layout).toBe("card");
    expect(r.rows).toEqual([
      { day: "2026-10-14", description: "AMAZON.CA*2K4LL11 TORONTO ON", amount: -64.2 },
      { day: "2026-10-20", description: "PAYMENT - THANK YOU", amount: 1204.11 },
      { day: "2026-11-01", description: "SHELL C12345 CALGARY AB", amount: -71.05 },
      { day: "2026-11-03", description: "REFUND BEST BUY #912", amount: 45 },
    ]);
  });

  it("says so when there's nothing to read", () => {
    expect(readStatement([], "2026-11-19").note).toContain("scan");
    expect(readStatement([{ page: 1, cells: [{ x: 0, right: 50, text: "Hello" }] }], "2026-11-19").rows).toHaveLength(0);
  });
});
