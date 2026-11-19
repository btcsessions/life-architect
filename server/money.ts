// Money: import statements, sort them into categories, and show where it goes.
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import type { Ctx } from "./app.ts";
import { chat, extractJson } from "./file.ts";
import { mountLock } from "./lock.ts";
import { saveFile, serve, deleteFile, type StoredFile } from "./files.ts";

export const CATEGORIES = ["Housing", "Business", "Travel", "Food", "Subscriptions", "Transport", "Health", "Shopping", "Entertainment", "Income", "Transfers", "Other"];

// Built-in guesses. Rules the user makes ("always put X in Y") win over these.
const DEFAULT_RULES: Array<[RegExp, string]> = [
  [/\b(netflix|spotify|disney\+?|crave|apple\.com\/bill|icloud|google \*?(one|storage|youtube)|youtube ?premium|patreon|substack|adobe|dropbox|openai|chatgpt|anthropic|claude\.ai|github|notion|canva|1password|proton|audible|prime video|amazon prime)\b/i, "Subscriptions"],
  [/\b(air canada|westjet|flair|porter|united|delta|expedia|booking\.com|airbnb|hotel|marriott|hilton|hyatt|vrbo|hostel|car rental|hertz|avis|enterprise rent)\b/i, "Travel"],
  [/\b(uber(?! ?eats)|lyft|taxi|shell|esso|petro[- ]?can|chevron|husky|co-?op gas|gas bar|parking|impark|transit|calgary transit)\b/i, "Transport"],
  [/\b(safeway|sobeys|superstore|costco|walmart|save[- ]on|no frills|co-?op|grocery|restaurant|skip ?the ?dishes|doordash|uber ?eats|starbucks|tim hortons|mcdonald|a&w|subway|pizza|sushi|cafe|coffee|pub|bar & grill|brewery)\b/i, "Food"],
  [/\b(rent|mortgage|enmax|atco|direct energy|hydro|telus|shaw|rogers|bell|property tax|condo fee|home insurance|strata)\b/i, "Housing"],
  [/\b(pharmacy|shoppers drug|rexall|dental|dentist|physio|clinic|optometr|massage|gym|goodlife|fitness)\b/i, "Health"],
  [/\b(cineplex|steam|playstation|nintendo|xbox|ticketmaster|concert|theatre|bowling)\b/i, "Entertainment"],
  [/\b(amazon|amzn|best buy|ikea|home depot|canadian tire|apple store|winners|lululemon)\b/i, "Shopping"],
  [/\b(payroll|direct deposit|adsense|google ads?ense|youtube.*(payment|earnings)|stripe|paypal transfer|e-?transfer (received|from)|interac.*(received|from)|refund|interest paid)\b/i, "Income"],
  [/\b(transfer to|transfer from|tfr|payment - thank you|payment thank you|credit card payment|e-?transfer (sent|to))\b/i, "Transfers"],
];

export interface Tx { id: number; day: string; description: string; merchant: string; amount: number; account: string | null; category: string; note: string | null; file_id: number | null }

/** One CSV line into cells, honouring quotes. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return +m[1] > 12 ? iso(+m[3], +m[2], +m[1]) : iso(+m[3], +m[1], +m[2]); // month first unless that can't be
  m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  m = t.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function parseAmount(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t) || /\bDR\b/i.test(t);
  t = t.replace(/[^0-9.,]/g, "");
  if (!t) return null;
  if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", "."); // 1.234,56
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** A short, stable name for who the money went to: "AMZN Mktp CA*2K4L 800-123" -> "Amzn Mktp Ca". */
export function merchantOf(description: string): string {
  const words = description
    .replace(/[*#]\S*/g, " ")
    .replace(/\b\d[\d-]{2,}\b/g, " ")
    .replace(/[^A-Za-z&'.+ -]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 3);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return name || description.trim().slice(0, 40) || "Unknown";
}

export interface ParsedRow { day: string; description: string; amount: number }

/** Read a bank or card export. Finds the date, description and amount columns from the header, or by shape. */
export function parseStatement(text: string, flip = false): { rows: ParsedRow[]; unreadable: number } {
  const table = splitCsv(text.replace(/^﻿/, ""));
  if (!table.length) return { rows: [], unreadable: 0 };
  const head = table[0].map((h) => h.trim().toLowerCase());
  const hasHeader = head.some((h) => /date|description|amount|debit|credit|details|memo|payee/.test(h)) && parseDate(table[0][0] ?? "") === null;
  const find = (re: RegExp) => head.findIndex((h) => re.test(h));
  let iDate = -1, iDesc = -1, iAmt = -1, iOut = -1, iIn = -1;
  if (hasHeader) {
    iDate = find(/^(transaction |posted |posting |trans\.? )?date$|^date/);
    iDesc = find(/description|details|memo|payee|merchant|name|narrative/);
    iAmt = find(/^amount|amount \(?cad|^cad\$?$|transaction amount/);
    iOut = find(/debit|withdraw|money out|paid out|charge/);
    iIn = find(/credit|deposit|money in|paid in/);
  }
  const body = hasHeader ? table.slice(1) : table;
  if (iDate < 0 || (iAmt < 0 && iOut < 0 && iIn < 0)) {
    // No usable header: work it out from the first few rows.
    const sample = body.slice(0, 8);
    const width = Math.max(...sample.map((r) => r.length));
    const score = (i: number, f: (s: string) => boolean) => sample.filter((r) => f(r[i] ?? "")).length;
    const cols = [...Array(width).keys()];
    iDate = cols.find((i) => score(i, (s) => parseDate(s) !== null) >= sample.length * 0.8) ?? -1;
    const numeric = cols.filter((i) => i !== iDate && score(i, (s) => !s.trim() || parseAmount(s) !== null) === sample.length && score(i, (s) => parseAmount(s) !== null) > 0);
    iDesc = cols.filter((i) => i !== iDate && !numeric.includes(i)).sort((a, b) => score(b, (s) => /[A-Za-z]{3}/.test(s)) - score(a, (s) => /[A-Za-z]{3}/.test(s)))[0] ?? -1;
    iAmt = -1; iOut = -1; iIn = -1;
    if (numeric.length === 1) iAmt = numeric[0];
    else if (numeric.length >= 2) { iOut = numeric[0]; iIn = numeric[1]; } // date, description, debit, credit[, balance]
  }
  const rows: ParsedRow[] = [];
  let unreadable = 0;
  for (const r of body) {
    const day = iDate >= 0 ? parseDate(r[iDate] ?? "") : null;
    const description = (iDesc >= 0 ? r[iDesc] ?? "" : "").replace(/\s+/g, " ").trim();
    let amount: number | null = null;
    if (iAmt >= 0) amount = parseAmount(r[iAmt] ?? "");
    else {
      const out = iOut >= 0 ? parseAmount(r[iOut] ?? "") : null;
      const inn = iIn >= 0 ? parseAmount(r[iIn] ?? "") : null;
      if (out) amount = -Math.abs(out);
      else if (inn) amount = Math.abs(inn);
    }
    if (!day || amount === null || amount === 0 || !description) { unreadable++; continue; }
    rows.push({ day, description, amount: flip ? -amount : amount });
  }
  return { rows, unreadable };
}

export function mountMoney(app: Hono, ctx: Ctx) {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS money_tx (
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, description TEXT NOT NULL, merchant TEXT NOT NULL,
      amount REAL NOT NULL, account TEXT, category TEXT NOT NULL, note TEXT, file_id INTEGER, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS money_tx_day ON money_tx(day);
    CREATE TABLE IF NOT EXISTS money_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, merchant TEXT NOT NULL UNIQUE, category TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS money_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, updated_at TEXT NOT NULL);
  `);
  mountLock(app, ctx, "money");

  const categorise = (description: string, merchant: string, amount: number): string => {
    const own = db.prepare("SELECT category FROM money_rules WHERE merchant = ?").get(merchant.toLowerCase()) as { category: string } | undefined;
    if (own) return own.category;
    const hit = DEFAULT_RULES.find(([re]) => re.test(description));
    if (hit) return hit[1];
    return amount > 0 ? "Income" : "Other";
  };

  // "nth" tells apart two identical lines in one statement (two coffees, or a real double charge),
  // while the same file imported twice still adds nothing.
  function addTx(day: string, description: string, amount: number, account: string | null, extra: { note?: string | null; file_id?: number | null; nth?: number } = {}): boolean {
    const merchant = merchantOf(description);
    const hash = createHash("sha256").update([day, description.toLowerCase(), amount.toFixed(2), account ?? "", extra.nth ?? 0].join("|")).digest("hex");
    const r = db.prepare(
      "INSERT OR IGNORE INTO money_tx (day, description, merchant, amount, account, category, note, file_id, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(day, description, merchant, amount, account, categorise(description, merchant, amount), extra.note ?? null, extra.file_id ?? null, hash, ctx.now().toISOString());
    return r.changes > 0;
  }

  app.post("/api/money/import", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Choose a statement file." }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: "That file is over 10 MB." }, 400);
    if (/\.(pdf|xlsx?|ofx|qfx|qif)$/i.test(file.name)) return c.json({ error: "Only CSV exports can be read so far. Most banks offer \"Download as CSV\" on the transactions page." }, 400);
    const account = String(form?.get("account") ?? "").trim().slice(0, 60) || null;
    const { rows, unreadable } = parseStatement(await file.text(), form?.get("flip") === "1");
    if (!rows.length) return c.json({ error: "Couldn't find any transactions in that file. It needs a date, a description and an amount on each line." }, 400);
    let added = 0;
    const seen = new Map<string, number>();
    db.transaction(() => {
      for (const r of rows) {
        const k = `${r.day}|${r.description.toLowerCase()}|${r.amount.toFixed(2)}`;
        const nth = seen.get(k) ?? 0;
        seen.set(k, nth + 1);
        if (addTx(r.day, r.description, r.amount, account, { nth })) added++;
      }
    })();
    return c.json({ added, already_there: rows.length - added, unreadable, from: rows.reduce((a, r) => (r.day < a ? r.day : a), rows[0].day), to: rows.reduce((a, r) => (r.day > a ? r.day : a), rows[0].day) });
  });

  // One transaction by hand, or from a receipt.
  app.post("/api/money/tx", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let b: Record<string, unknown>, fileId: number | null = null;
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      b = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
      const f = form.get("file");
      if (f instanceof File && f.size) {
        try { fileId = (await saveFile(ctx, f, "money")).id; } catch (e) { return c.json({ error: (e as Error).message }, 400); }
      }
    } else b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const day = parseDate(String(b.day ?? "")) ?? ctx.day();
    const amount = parseAmount(String(b.amount ?? ""));
    const description = String(b.description ?? "").trim().slice(0, 200);
    if (amount === null || amount === 0) return c.json({ error: "Enter the amount." }, 400);
    if (!description) return c.json({ error: "Say what it was for." }, 400);
    const signed = b.kind === "in" ? Math.abs(amount) : -Math.abs(amount);
    if (!addTx(day, description, signed, "By hand", { file_id: fileId })) return c.json({ error: "That exact entry is already there." }, 409);
    return c.json({ ok: true });
  });

  app.get("/api/money/files/:id", (c) => {
    const f = db.prepare("SELECT * FROM files WHERE id = ? AND owner = 'money'").get(Number(c.req.param("id"))) as StoredFile | undefined;
    return f ? serve(f) : c.json({ error: "No such file." }, 404);
  });

  const monthsWithData = () => (db.prepare("SELECT DISTINCT substr(day, 1, 7) AS m FROM money_tx ORDER BY m DESC").all() as Array<{ m: string }>).map((r) => r.m);
  const inMonth = (m: string) => db.prepare("SELECT * FROM money_tx WHERE substr(day, 1, 7) = ? ORDER BY day DESC, id DESC").all(m) as Tx[];
  const sums = (txs: Tx[]) => {
    const real = txs.filter((t) => t.category !== "Transfers");
    const inn = real.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const out = -real.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
    return { in: inn, out, left: inn - out };
  };

  /** Things that look worth a second look: repeating charges, price rises, the same charge twice. */
  function savings(month: string): Array<{ text: string; amount: number }> {
    const out: Array<{ text: string; amount: number }> = [];
    const all = db.prepare("SELECT * FROM money_tx WHERE amount < 0 AND category != 'Transfers' AND substr(day, 1, 7) <= ? ORDER BY day").all(month) as Tx[];
    const byMerchant = new Map<string, Tx[]>();
    for (const t of all) byMerchant.set(t.merchant, [...(byMerchant.get(t.merchant) ?? []), t]);
    const recurring: Array<{ m: string; latest: number; first: number; months: number }> = [];
    for (const [m, txs] of byMerchant) {
      const months = new Map<string, number>();
      for (const t of txs) months.set(t.day.slice(0, 7), (months.get(t.day.slice(0, 7)) ?? 0) + -t.amount);
      const vals = [...months.values()];
      if (months.size >= 3 && months.has(month) && Math.max(...vals) <= Math.min(...vals) * 1.35) recurring.push({ m, latest: months.get(month)!, first: vals[0], months: months.size });
    }
    const subs = recurring.filter((r) => r.latest < 200);
    if (subs.length) {
      const total = subs.reduce((s, r) => s + r.latest, 0);
      out.push({ text: `${subs.length} charge${subs.length === 1 ? "" : "s"} repeat every month: ${subs.sort((a, b) => b.latest - a.latest).slice(0, 5).map((r) => r.m).join(", ")}. Worth checking you still use them all.`, amount: total });
    }
    for (const r of recurring) if (r.latest > r.first * 1.1 && r.latest - r.first >= 1) out.push({ text: `${r.m} costs more than it did when it first appeared here.`, amount: r.latest - r.first });
    const seen = new Map<string, Tx>();
    for (const t of inMonth(month)) {
      if (t.amount >= 0) continue;
      const k = `${t.merchant}|${t.amount.toFixed(2)}|${t.day}`;
      if (seen.has(k)) out.push({ text: `${t.merchant} charged the same amount twice on ${t.day}.`, amount: -t.amount });
      seen.set(k, t);
    }
    return out.slice(0, 6);
  }

  app.get("/api/money/summary", (c) => {
    const months = monthsWithData();
    const month = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? c.req.query("month")! : months[0] ?? ctx.day().slice(0, 7);
    const txs = inMonth(month);
    const prevMonth = months.find((m) => m < month);
    const spend = txs.filter((t) => t.amount < 0 && t.category !== "Transfers");
    const total = -spend.reduce((s, t) => s + t.amount, 0);
    const group = (list: Tx[], key: (t: Tx) => string) => {
      const m = new Map<string, { total: number; count: number }>();
      for (const t of list) { const g = m.get(key(t)) ?? { total: 0, count: 0 }; g.total += Math.abs(t.amount); g.count++; m.set(key(t), g); }
      return [...m.entries()].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.total - a.total);
    };
    const categories = group(spend, (t) => t.category).map((g) => ({
      ...g, share: total ? g.total / total : 0,
      merchants: group(spend.filter((t) => t.category === g.name), (t) => t.merchant).slice(0, 12),
    }));
    const income = group(txs.filter((t) => t.amount > 0 && t.category !== "Transfers"), (t) => t.merchant);
    const tasks = db.prepare("SELECT id, title, due, due_time, minutes FROM tasks WHERE area_id = 'money' AND status = 'open' ORDER BY due IS NULL, due").all();
    return c.json({
      month, months, ...sums(txs), previous: prevMonth ? { month: prevMonth, ...sums(inMonth(prevMonth)) } : null,
      categories, income, savings: savings(month), tasks, count: txs.length,
      unsorted: txs.filter((t) => t.category === "Other").length, has_model: Boolean(ctx.modelFor("money_llm")),
    });
  });

  app.get("/api/money/tx", (c) => {
    const month = c.req.query("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "Say which month." }, 400);
    const cat = c.req.query("category"), merchant = c.req.query("merchant");
    return c.json({ categories: CATEGORIES, tx: inMonth(month).filter((t) => (!cat || t.category === cat) && (!merchant || t.merchant === merchant)) });
  });

  // Re-sort one transaction; with "always", every one from that merchant, now and in future.
  app.patch("/api/money/tx/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const t = db.prepare("SELECT * FROM money_tx WHERE id = ?").get(id) as Tx | undefined;
    if (!t) return c.json({ error: "That transaction is gone." }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!CATEGORIES.includes(b.category as string)) return c.json({ error: "Pick a category." }, 400);
    if (b.always) {
      db.prepare("INSERT INTO money_rules (merchant, category) VALUES (?, ?) ON CONFLICT(merchant) DO UPDATE SET category = excluded.category").run(t.merchant.toLowerCase(), b.category);
      db.prepare("UPDATE money_tx SET category = ? WHERE merchant = ?").run(b.category, t.merchant);
    } else db.prepare("UPDATE money_tx SET category = ? WHERE id = ?").run(b.category, id);
    return c.json({ ok: true });
  });

  app.delete("/api/money/tx/:id", (c) => {
    const t = db.prepare("SELECT * FROM money_tx WHERE id = ?").get(Number(c.req.param("id"))) as Tx | undefined;
    if (!t) return c.json({ error: "That transaction is gone." }, 404);
    if (t.file_id) deleteFile(ctx, t.file_id);
    db.prepare("DELETE FROM money_tx WHERE id = ?").run(t.id);
    return c.json({ ok: true });
  });

  // Ask Money's own model to sort what the rules couldn't. Only merchant names are sent: no amounts, dates or accounts.
  app.post("/api/money/sort", async (c) => {
    const cfg = ctx.modelFor("money_llm");
    if (!cfg) return c.json({ error: "Set a model for Money in Settings first." }, 400);
    const merchants = (db.prepare("SELECT DISTINCT merchant FROM money_tx WHERE category = 'Other' LIMIT 60").all() as Array<{ merchant: string }>).map((r) => r.merchant);
    if (!merchants.length) return c.json({ sorted: 0 });
    try {
      const answer = await chat(cfg, [
        { role: "system", content: `Sort each merchant name into one of: ${CATEGORIES.filter((x) => x !== "Other").join(", ")}, or "Other" if you can't tell. Reply with ONLY a JSON object mapping each name exactly as given to its category.` },
        { role: "user", content: JSON.stringify(merchants) },
      ]);
      const map = extractJson(answer) as Record<string, unknown>;
      let sorted = 0;
      for (const m of merchants) {
        const cat = map?.[m];
        if (typeof cat === "string" && CATEGORIES.includes(cat) && cat !== "Other") {
          db.prepare("INSERT INTO money_rules (merchant, category) VALUES (?, ?) ON CONFLICT(merchant) DO UPDATE SET category = excluded.category").run(m.toLowerCase(), cat);
          sorted += db.prepare("UPDATE money_tx SET category = ? WHERE merchant = ? AND category = 'Other'").run(cat, m).changes;
        }
      }
      return c.json({ sorted });
    } catch (e) {
      return c.json({ error: `Couldn't sort them: ${(e as Error).message}.` }, 502);
    }
  });

  app.get("/api/money/assets", (c) => c.json({ assets: db.prepare("SELECT * FROM money_assets ORDER BY value DESC").all() }));
  app.post("/api/money/assets", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const value = parseAmount(String(b.value ?? ""));
    if (typeof b.name !== "string" || !b.name.trim()) return c.json({ error: "Give it a name." }, 400);
    if (value === null) return c.json({ error: "Enter what it's worth." }, 400);
    db.prepare("INSERT INTO money_assets (name, kind, value, updated_at) VALUES (?, ?, ?, ?)").run(b.name.trim().slice(0, 80), String(b.kind || "Other").slice(0, 40), value, ctx.day());
    return c.json({ ok: true });
  });
  app.patch("/api/money/assets/:id", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const value = parseAmount(String(b.value ?? ""));
    if (value === null) return c.json({ error: "Enter what it's worth." }, 400);
    return db.prepare("UPDATE money_assets SET value = ?, updated_at = ? WHERE id = ?").run(value, ctx.day(), Number(c.req.param("id"))).changes ? c.json({ ok: true }) : c.json({ error: "No such entry." }, 404);
  });
  app.delete("/api/money/assets/:id", (c) => (db.prepare("DELETE FROM money_assets WHERE id = ?").run(Number(c.req.param("id"))).changes ? c.json({ ok: true }) : c.json({ error: "No such entry." }, 404)));
  return { addTx };
}
