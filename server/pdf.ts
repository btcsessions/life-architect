// Reads bank and card statements that come as PDFs. Everything happens on the Umbrel: the text is pulled out of the
// PDF here and matched by shape (a date, a description, an amount). No model sees the statement.
export interface Cell { x: number; right: number; text: string }
export interface Line { page: number; cells: Cell[] }
export interface PdfRow { day: string; description: string; amount: number }
export interface PdfResult { rows: PdfRow[]; skipped: number; layout: "columns" | "balance" | "card" | "none"; note?: string }

/** Pull the text out of a PDF as lines of positioned cells. Throws a plain-English error if it can't. */
export async function pdfLines(data: Uint8Array): Promise<Line[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try { doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise; }
  catch (e) {
    if ((e as Error).name === "PasswordException") throw new Error("That PDF is password-protected. Open it, save or print it to a new PDF without the password, and import that.");
    throw new Error("That file couldn't be opened as a PDF.");
  }
  const lines: Line[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 80); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, Cell[]>();
    for (const it of content.items as any[]) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      // Same visual line if within a couple of points vertically.
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2.5) ?? y;
      rows.set(key, [...(rows.get(key) ?? []), { x, right: x + it.width, text: it.str.trim() }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) lines.push({ page: p, cells: rows.get(y)!.sort((a, b) => a.x - b.x) });
  }
  await doc.destroy();
  return lines;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
// A date at the start of a line, in the shapes statements use. Year is often missing.
const DATE_AT = [
  new RegExp(`^${MON}\\s*(\\d{1,2})(?:,?\\s*(\\d{4}))?(?![\\d.,])`, "i"), // Nov 3 / NOV03 / Nov 3, 2026
  new RegExp(`^(\\d{1,2})[\\s-]*${MON}(?:[\\s-]*(\\d{4}|\\d{2}))?(?![\\d.,])`, "i"), // 3 Nov / 03-NOV-26
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, // 2026-11-03
  /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d.,])/, // 11/03 or 11/03/2026 (month first)
];
const AMOUNT = /^\(?[-+]?\s?\$?\s?\d{1,3}(?:,?\d{3})*\.\d{2}\)?\s?(?:-|CR|DR)?$/i;
const SKIP = /\b(opening balance|closing balance|balance forward|previous balance|new balance|previous statement|statement balance|total|subtotal|sub-total|minimum payment|credit limit|available credit|amount due|interest rate|annual interest)\b/i;
const HEAD_OUT = /withdraw|debit|cheque|payments? out|money out|paid out|charges/i;
const HEAD_IN = /deposit|credit|money in|paid in|payments? in/i;
const HEAD_BAL = /balance/i;

interface Partial { month: number; day: number; year: number | null }
function dateAt(text: string): { d: Partial; rest: string } | null {
  for (let i = 0; i < DATE_AT.length; i++) {
    const m = text.match(DATE_AT[i]);
    if (!m) continue;
    let d: Partial;
    if (i === 0) d = { month: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, day: +m[2], year: m[3] ? +m[3] : null };
    else if (i === 1) d = { day: +m[1], month: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, year: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null };
    else if (i === 2) d = { year: +m[1], month: +m[2], day: +m[3] };
    else d = { month: +m[1], day: +m[2], year: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null };
    if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > 31) continue;
    return { d, rest: text.slice(m[0].length).trim() };
  }
  return null;
}
const num = (s: string) => Number(s.replace(/[^0-9.]/g, ""));
const credit = (s: string) => /CR$/i.test(s.trim()) || /^\(.*\)$/.test(s.trim()) || /^-/.test(s.trim()) || /-$/.test(s.trim());

/** Find the transactions in the lines of a statement. `today` (YYYY-MM-DD) settles dates printed without a year. */
export function readStatement(lines: Line[], today: string): PdfResult {
  if (!lines.length) return { rows: [], skipped: 0, layout: "none", note: "This PDF is a scan (a picture of a statement), so there's no text in it to read. Download the statement from your bank's site instead of scanning it." };
  const all = lines.map((l) => l.cells.map((c) => c.text).join(" ")).join("\n");
  const years = [...all.matchAll(/\b(20\d{2})\b/g)].map((m) => +m[1]).filter((y) => y <= +today.slice(0, 4) + 1);
  const count = new Map<number, number>();
  for (const y of years) count.set(y, (count.get(y) ?? 0) + 1);
  const stmtYear = years.length ? Math.max(...[...count.entries()].filter(([, n]) => n >= Math.max(1, Math.max(...count.values()) / 4)).map(([y]) => y)) : +today.slice(0, 4);

  // Column headers, if the statement has "Withdrawals / Deposits / Balance" style columns.
  let cols: { out?: number; inn?: number; bal?: number } | null = null;
  for (const l of lines) {
    const out = l.cells.find((c) => HEAD_OUT.test(c.text) && c.text.length < 40), inn = l.cells.find((c) => HEAD_IN.test(c.text) && c.text.length < 40 && c !== out);
    if (out && inn) { cols = { out: out.right, inn: inn.right, bal: l.cells.find((c) => HEAD_BAL.test(c.text) && c !== out && c !== inn)?.right }; break; }
  }

  interface Raw { d: Partial; description: string; amounts: Cell[] }
  const raw: Raw[] = [];
  let skipped = 0, opening: number | null = null;
  for (const l of lines) {
    const text = l.cells.map((c) => c.text).join(" ");
    const amounts = l.cells.filter((c) => AMOUNT.test(c.text));
    if (/\b(opening balance|balance forward|previous balance|previous statement)\b/i.test(text) && amounts.length) opening = num(amounts[amounts.length - 1].text) * (credit(amounts[amounts.length - 1].text) ? -1 : 1);
    const hit = dateAt(text);
    if (!hit) continue;
    if (!amounts.length) continue;
    let rest = hit.rest;
    const second = dateAt(rest); // card statements print a transaction date and a posting date
    if (second) rest = second.rest;
    // The description is what sits between the date(s) and the first amount.
    for (const a of amounts) { const i = rest.lastIndexOf(a.text); if (i >= 0) rest = rest.slice(0, i) + rest.slice(i + a.text.length); }
    const description = rest.replace(/\s+/g, " ").replace(/[$\s]+$/, "").trim();
    if (SKIP.test(description) || SKIP.test(text.slice(0, 60))) continue;
    if (description.length < 2) { skipped++; continue; }
    raw.push({ d: hit.d, description: description.slice(0, 200), amounts });
  }
  if (!raw.length) return { rows: [], skipped, layout: "none", note: "Couldn't find any transactions in that PDF. It needs lines with a date, a description and an amount." };

  // Which way does the money go?
  const twoAmounts = raw.filter((r) => r.amounts.length >= 2).length;
  const layout: PdfResult["layout"] = cols ? "columns" : twoAmounts >= raw.length * 0.6 ? "balance" : "card";
  const signed: Array<{ d: Partial; description: string; amount: number }> = [];
  let prev = opening;
  for (const r of raw) {
    let amount: number | null = null;
    if (layout === "columns") {
      const near = (c: Cell) => ([["out", cols!.out], ["inn", cols!.inn], ["bal", cols!.bal]] as const).filter(([, x]) => x !== undefined).sort((a, b) => Math.abs(c.right - a[1]!) - Math.abs(c.right - b[1]!))[0][0];
      const cell = r.amounts.find((c) => near(c) !== "bal");
      if (cell) amount = num(cell.text) * (near(cell) === "inn" ? 1 : -1);
    } else if (layout === "balance" && r.amounts.length >= 2) {
      const a = num(r.amounts[0].text), last = r.amounts[r.amounts.length - 1], bal = num(last.text) * (credit(last.text) ? -1 : 1);
      if (prev !== null && Math.abs(prev + a - bal) < 0.011) amount = a;
      else if (prev !== null && Math.abs(prev - a - bal) < 0.011) amount = -a;
      else amount = /deposit|payroll|e-?transfer (from|received)|refund|interest paid|credit memo/i.test(r.description) ? a : -a;
      prev = bal;
    } else {
      // Card statement: a plain number is spending; CR, a minus or brackets is money back.
      const c = r.amounts[0];
      amount = credit(c.text) || /payment.{0,12}(thank|received)|paiement.{0,10}merci|refund|credit adjustment/i.test(r.description) ? num(c.text) : -num(c.text);
    }
    if (amount === null || amount === 0) { skipped++; continue; }
    signed.push({ d: r.d, description: r.description, amount });
  }

  // Years: statements that run December into January print no year on each line.
  const months = new Set(signed.filter((s) => s.d.year === null).map((s) => s.d.month));
  const wraps = months.has(12) && months.has(1);
  const pad = (n: number) => String(n).padStart(2, "0");
  const rows = signed.map((s) => {
    let y = s.d.year ?? stmtYear;
    if (s.d.year === null && wraps && s.d.month >= 11) y = stmtYear - 1;
    let day = `${y}-${pad(s.d.month)}-${pad(s.d.day)}`;
    if (s.d.year === null && day > today) day = `${y - 1}-${pad(s.d.month)}-${pad(s.d.day)}`;
    return { day, description: s.description, amount: Math.round(s.amount * 100) / 100 };
  });
  return { rows, skipped, layout };
}
