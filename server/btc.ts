// Bitcoin wallets in Money, watch-only from an xpub / ypub / zpub (or a single-key descriptor).
// Addresses are looked up on the server set in Money (meant to be your own node's mempool or Esplora).
// Prices come from a separate price source that is only ever sent dates, never addresses or amounts.
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { base58check } from "@scure/base";
import type { Ctx } from "./app.ts";

const b58 = base58check((d: Uint8Array) => new Uint8Array(createHash("sha256").update(d).digest()));
export const TYPES = ["wpkh", "sh-wpkh", "pkh", "tr"] as const;
export type AddrType = (typeof TYPES)[number];
export const TYPE_NAMES: Record<AddrType, string> = { wpkh: "Native SegWit (bc1q…)", "sh-wpkh": "Nested SegWit (3…)", pkh: "Legacy (1…)", tr: "Taproot (bc1p…)" };
const GAP = 20;

/** Read what was pasted: an extended public key or a single-key descriptor. Never accepts private keys. */
export function parseKey(input: string): { hd: HDKey; type: AddrType | null; xpub: string; end: string } {
  const text = input.trim();
  if (/\b[xyzYZ]prv[1-9A-HJ-NP-Za-km-z]{20,}/.test(text)) throw new Error("That's a private key. Only paste the public one (xpub, ypub or zpub).");
  if (/\b(multi|sortedmulti)\(/.test(text) || /\b[YZ]pub/.test(text)) throw new Error("Multisig wallets aren't supported yet. Only single-key wallets.");
  const key = text.match(/[xyz]pub[1-9A-HJ-NP-Za-km-z]{90,120}/)?.[0];
  if (!key) throw new Error("That doesn't look like an xpub, ypub or zpub.");
  let type: AddrType | null = key.startsWith("zpub") ? "wpkh" : key.startsWith("ypub") ? "sh-wpkh" : null;
  const d = text.match(/^\s*(sh\(wpkh|wpkh|pkh|tr)\(/);
  if (d) type = d[1] === "sh(wpkh" ? "sh-wpkh" : (d[1] as AddrType);
  let raw: Uint8Array;
  try { raw = b58.decode(key); } catch { throw new Error("That key has a typo in it (the checksum doesn't match)."); }
  raw.set([0x04, 0x88, 0xb2, 0x1e], 0); // read every flavour as a plain xpub
  const xpub = b58.encode(raw);
  return { hd: HDKey.fromExtendedKey(xpub), type, xpub, end: key.slice(-6) };
}

export function addressOf(hd: HDKey, type: AddrType, chain: number, index: number): string {
  const pub = hd.deriveChild(chain).deriveChild(index).publicKey!;
  if (type === "wpkh") return btc.p2wpkh(pub).address!;
  if (type === "sh-wpkh") return btc.p2sh(btc.p2wpkh(pub)).address!;
  if (type === "pkh") return btc.p2pkh(pub).address!;
  return btc.p2tr(pub.slice(1)).address!;
}

interface ApiTx { txid: string; fee?: number; status?: { confirmed?: boolean; block_time?: number }; vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } | null }>; vout: Array<{ scriptpubkey_address?: string; value?: number }> }
const dayOf = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const publicHost = (url: string) => { try { const h = new URL(url).hostname; return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) && h.includes(".") && !/\.(local|lan|internal)$/.test(h); } catch { return false; } };

export function mountBtc(app: Hono, ctx: Ctx, linkTransfers: () => number) {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS btc_wallet (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE, xpub TEXT NOT NULL, type TEXT NOT NULL, synced_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS btc_addr (wallet_id INTEGER NOT NULL, chain INTEGER NOT NULL, idx INTEGER NOT NULL, address TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (wallet_id, chain, idx));
    CREATE INDEX IF NOT EXISTS btc_addr_address ON btc_addr(address);
    CREATE TABLE IF NOT EXISTS btc_tx (wallet_id INTEGER NOT NULL, txid TEXT NOT NULL, net INTEGER NOT NULL, fee INTEGER, time INTEGER, confirmed INTEGER NOT NULL, PRIMARY KEY (wallet_id, txid));
    CREATE TABLE IF NOT EXISTS btc_price (day TEXT PRIMARY KEY, cad REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS btc_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (!(db.prepare("PRAGMA table_info(btc_wallet)").all() as Array<{ name: string }>).some((c) => c.name === "key_end")) db.exec("ALTER TABLE btc_wallet ADD COLUMN key_end TEXT");
  const conf = (k: string) => (db.prepare("SELECT value FROM btc_config WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? "";
  const setConf = (k: string, v: string) => db.prepare("INSERT INTO btc_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  const base = (k: string) => conf(k).replace(/\/+$/, "");
  const priceBase = () => base("price_api") || "https://mempool.space/api";
  // Public servers limit how fast they can be asked, so wait and retry when told to slow down.
  const get = async (url: string) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return r.json();
      if ((r.status === 429 || r.status === 503) && attempt < 5 && !process.env.VITEST) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
      throw new Error(r.status === 429 ? `${new URL(url).host} is limiting requests; try again in a few minutes` : `${new URL(url).host} answered ${r.status}`);
    }
  };

  /** Every transaction touching one address, following the server's paging. */
  async function addressTxs(address: string): Promise<ApiTx[]> {
    const api = base("api");
    const out: ApiTx[] = (await get(`${api}/address/${address}/txs`)) as ApiTx[];
    let page = out.filter((t) => t.status?.confirmed);
    while (page.length >= 25 && out.length < 5000) {
      page = (await get(`${api}/address/${address}/txs/chain/${page[page.length - 1].txid}`)) as ApiTx[];
      out.push(...page);
    }
    return out;
  }

  /** CAD per BTC for each day asked for. One request for the whole history; only the currency is sent. */
  async function prices(days: string[]): Promise<Map<string, number>> {
    const have = new Map<string, number>();
    const row = db.prepare("SELECT cad FROM btc_price WHERE day = ?");
    const missing = [...new Set(days)].filter((d) => { const r = row.get(d) as { cad: number } | undefined; if (r) have.set(d, r.cad); return !r; });
    if (missing.length) {
      try {
        const j = (await get(`${priceBase()}/v1/historical-price?currency=CAD`)) as { prices?: Array<{ time: number; CAD?: number }> };
        const byDay = new Map<string, number>();
        for (const p of j.prices ?? []) if (p.CAD && p.CAD > 0) byDay.set(dayOf(p.time), p.CAD);
        const known = [...byDay.keys()].sort();
        const put = db.prepare("INSERT OR REPLACE INTO btc_price (day, cad) VALUES (?, ?)");
        for (const d of missing) {
          // The exact day, or the closest earlier one the source has.
          const k = byDay.has(d) ? d : known.filter((x) => x <= d).pop();
          if (k) { have.set(d, byDay.get(k)!); if (d < ctx.day()) put.run(d, byDay.get(k)!); }
        }
      } catch { /* rows without a price are filled in on the next sync */ }
    }
    return have;
  }
  async function priceNow(): Promise<number | null> {
    try { const j = (await get(`${priceBase()}/v1/prices`)) as { CAD?: number }; if (j.CAD && j.CAD > 0) { setConf("last_price", String(j.CAD)); return j.CAD; } } catch { /* fall through */ }
    return Number(conf("last_price")) || null;
  }

  /** Walk one wallet's addresses until 20 in a row are unused, on both the receive and change chains. */
  async function scan(w: any): Promise<Map<string, ApiTx>> {
    const hd = HDKey.fromExtendedKey(w.xpub);
    const txs = new Map<string, ApiTx>();
    for (const chain of [0, 1]) {
      let quiet = 0;
      for (let idx = 0; quiet < GAP && idx < 5000; idx += 5) {
        const batch = [0, 1, 2, 3, 4].map((k) => ({ idx: idx + k, address: addressOf(hd, w.type as AddrType, chain, idx + k) }));
        const results: ApiTx[][] = [];
        if (publicHost(base("api"))) { for (const a of batch) results.push(await addressTxs(a.address)); } // one at a time on a public server
        else results.push(...(await Promise.all(batch.map((a) => addressTxs(a.address)))));
        batch.forEach((a, k) => {
          const used = results[k].length > 0;
          db.prepare("INSERT INTO btc_addr (wallet_id, chain, idx, address, used) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet_id, chain, idx) DO UPDATE SET used = excluded.used").run(w.id, chain, a.idx, a.address, used ? 1 : 0);
          quiet = used ? 0 : quiet + 1;
          for (const t of results[k]) txs.set(t.txid, t);
        });
      }
    }
    return txs;
  }

  /** Bring every wallet up to date and rewrite its lines in Money. */
  async function sync(): Promise<{ wallets: number; transactions: number; transfers: number }> {
    if (!base("api")) throw new Error("Set the address server first.");
    const wallets = db.prepare("SELECT * FROM btc_wallet ORDER BY id").all() as any[];
    for (const w of wallets) {
      const txs = await scan(w);
      const mine = new Set((db.prepare("SELECT address FROM btc_addr WHERE wallet_id = ?").all(w.id) as Array<{ address: string }>).map((a) => a.address));
      const put = db.prepare("INSERT INTO btc_tx (wallet_id, txid, net, fee, time, confirmed) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(wallet_id, txid) DO UPDATE SET net = excluded.net, fee = excluded.fee, time = excluded.time, confirmed = excluded.confirmed");
      db.transaction(() => {
        for (const t of txs.values()) {
          const inn = t.vout.reduce((a, o) => a + (o.scriptpubkey_address && mine.has(o.scriptpubkey_address) ? o.value ?? 0 : 0), 0);
          const out = t.vin.reduce((a, i) => a + (i.prevout?.scriptpubkey_address && mine.has(i.prevout.scriptpubkey_address) ? i.prevout.value ?? 0 : 0), 0);
          put.run(w.id, t.txid, inn - out, t.fee ?? null, t.status?.block_time ?? null, t.status?.confirmed ? 1 : 0);
        }
      })();
      db.prepare("UPDATE btc_wallet SET synced_at = ? WHERE id = ?").run(ctx.now().toISOString(), w.id);
    }
    return { wallets: wallets.length, ...(await ledger()) };
  }

  /** Mirror confirmed wallet transactions into Money's list, valued in CAD on the day they confirmed. */
  async function ledger(): Promise<{ transactions: number; transfers: number }> {
    const rows = db.prepare("SELECT t.*, w.label FROM btc_tx t JOIN btc_wallet w ON w.id = t.wallet_id WHERE t.confirmed = 1 AND t.time IS NOT NULL AND t.net != 0").all() as any[];
    const px = await prices(rows.map((r) => dayOf(r.time)));
    // The same transaction in two of your wallets is you moving coins between them.
    const seenIn = new Map<string, any[]>();
    for (const r of rows) seenIn.set(r.txid, [...(seenIn.get(r.txid) ?? []), r]);
    let transactions = 0, transfers = 0;
    const find = db.prepare("SELECT * FROM money_tx WHERE txid = ? AND wallet_id = ?");
    db.transaction(() => {
      for (const r of rows) {
        const day = dayOf(r.time), cad = px.get(day);
        if (!cad) continue;
        const others = (seenIn.get(r.txid) ?? []).filter((o) => o.wallet_id !== r.wallet_id);
        const other = others.find((o) => Math.sign(o.net) !== Math.sign(r.net));
        const amount = Math.round((r.net / 1e8) * cad * 100) / 100;
        const description = other ? (r.net < 0 ? `Bitcoin moved to ${other.label}` : `Bitcoin moved from ${other.label}`) : r.net > 0 ? "Bitcoin received" : "Bitcoin sent";
        const had = find.get(r.txid, r.wallet_id) as any;
        if (had) {
          // Keep any label or category he chose; only correct what the chain says.
          const becameTransfer = other && had.category !== "Transfers" && !had.keep_cat;
          db.prepare("UPDATE money_tx SET day = ?, amount = ?, sats = ?, account = ?, description = CASE WHEN description LIKE 'Bitcoin %' THEN ? ELSE description END, category = ? WHERE id = ?")
            .run(day, amount || (r.net > 0 ? 0.01 : -0.01), r.net, r.label, description, becameTransfer ? "Transfers" : had.category, had.id);
        } else {
          const hash = createHash("sha256").update(`btc|${r.wallet_id}|${r.txid}`).digest("hex");
          db.prepare("INSERT OR IGNORE INTO money_tx (day, description, merchant, amount, account, category, hash, created_at, sats, txid, wallet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(day, description, "Bitcoin", amount || (r.net > 0 ? 0.01 : -0.01), r.label, other ? "Transfers" : r.net > 0 ? "Income" : "Other", hash, ctx.now().toISOString(), r.net, r.txid, r.wallet_id);
          transactions++;
        }
        if (other) transfers++;
      }
      // Pair the two sides of each move so they open together.
      for (const [txid, list] of seenIn) {
        if (list.length < 2) continue;
        const a = find.get(txid, list[0].wallet_id) as any, b = find.get(txid, list[1].wallet_id) as any;
        if (a && b) { db.prepare("UPDATE money_tx SET pair_id = ? WHERE id = ?").run(b.id, a.id); db.prepare("UPDATE money_tx SET pair_id = ? WHERE id = ?").run(a.id, b.id); }
      }
    })();
    linkTransfers();
    return { transactions, transfers: Math.floor(transfers / 2) };
  }

  async function view() {
    const now = await priceNow();
    const wallets = (db.prepare("SELECT * FROM btc_wallet ORDER BY id").all() as any[]).map((w) => {
      const s = db.prepare("SELECT coalesce(sum(net), 0) AS sats, count(*) AS n, sum(confirmed = 0) AS pending FROM btc_tx WHERE wallet_id = ?").get(w.id) as any;
      return { id: w.id, label: w.label, type: w.type, type_name: TYPE_NAMES[w.type as AddrType], key_end: w.key_end ?? w.xpub.slice(-6), synced_at: w.synced_at, sats: s.sats, transactions: s.n, pending: s.pending ?? 0, cad: now ? Math.round((s.sats / 1e8) * now * 100) / 100 : null };
    });
    return {
      wallets, price: now, total_sats: wallets.reduce((a, w) => a + w.sats, 0), total_cad: now ? Math.round(wallets.reduce((a, w) => a + (w.cad ?? 0), 0) * 100) / 100 : null,
      api: conf("api"), price_api: conf("price_api"), api_is_public: publicHost(conf("api")), types: TYPE_NAMES,
    };
  }

  app.get("/api/money/btc", async (c) => c.json(await view()));

  app.put("/api/money/btc/config", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    for (const k of ["api", "price_api"] as const) {
      if (!(k in b)) continue;
      const v = String(b[k] ?? "").trim();
      if (v && !/^https?:\/\/\S+$/.test(v)) return c.json({ error: "Addresses start with http:// or https://" }, 400);
      setConf(k, v);
    }
    if (b.test) {
      try { await get(`${base("api")}/blocks/tip/height`); } catch (e) { return c.json({ error: `Couldn't reach that server: ${(e as Error).message}.` }, 502); }
    }
    return c.json(await view());
  });

  app.post("/api/money/btc/wallets", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as any;
    const label = String(b.label ?? "").trim().slice(0, 60);
    if (!label) return c.json({ error: "Give the wallet a name, like Spending or Taxes." }, 400);
    if (db.prepare("SELECT 1 FROM btc_wallet WHERE lower(label) = lower(?)").get(label)) return c.json({ error: "There's already a wallet with that name." }, 409);
    let k;
    try { k = parseKey(String(b.key ?? "")); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    if (db.prepare("SELECT 1 FROM btc_wallet WHERE xpub = ?").get(k.xpub) && !TYPES.includes(b.type)) return c.json({ error: "That key is already added." }, 409);
    let type: AddrType | null = TYPES.includes(b.type) ? b.type : k.type;
    if (!type) {
      // A plain xpub doesn't say which kind of address it makes, so look for the kind that has been used.
      if (!base("api")) return c.json({ error: "Set the address server first, or pick the address type yourself." }, 400);
      try {
        for (const t of TYPES) {
          const hits = await Promise.all([0, 1, 2].map((i) => addressTxs(addressOf(k.hd, t, 0, i))));
          if (hits.some((h) => h.length)) { type = t; break; }
        }
      } catch (e) { return c.json({ error: `Couldn't reach the address server: ${(e as Error).message}.` }, 502); }
      if (!type) return c.json({ error: "Couldn't tell which address type this xpub uses (none of the first few have been used). Pick the type and add it again.", need_type: true }, 400);
    }
    const id = Number(db.prepare("INSERT INTO btc_wallet (label, xpub, type, created_at, key_end) VALUES (?, ?, ?, ?, ?)").run(label, k.xpub, type, ctx.now().toISOString(), k.end).lastInsertRowid);
    return c.json({ id, label, type, first_address: addressOf(k.hd, type, 0, 0) });
  });

  app.patch("/api/money/btc/wallets/:id", async (c) => {
    const w = db.prepare("SELECT * FROM btc_wallet WHERE id = ?").get(Number(c.req.param("id"))) as any;
    if (!w) return c.json({ error: "No such wallet." }, 404);
    const label = String(((await c.req.json().catch(() => ({}))) as any).label ?? "").trim().slice(0, 60);
    if (!label) return c.json({ error: "Give it a name." }, 400);
    db.prepare("UPDATE btc_wallet SET label = ? WHERE id = ?").run(label, w.id);
    db.prepare("UPDATE money_tx SET account = ? WHERE wallet_id = ?").run(label, w.id);
    return c.json({ ok: true });
  });

  app.delete("/api/money/btc/wallets/:id", (c) => {
    const id = Number(c.req.param("id"));
    db.transaction(() => {
      db.prepare("UPDATE money_tx SET pair_id = NULL WHERE pair_id IN (SELECT id FROM money_tx WHERE wallet_id = ?)").run(id);
      for (const t of ["btc_tx", "btc_addr"]) db.prepare(`DELETE FROM ${t} WHERE wallet_id = ?`).run(id);
      db.prepare("DELETE FROM money_tx WHERE wallet_id = ?").run(id);
      db.prepare("DELETE FROM btc_wallet WHERE id = ?").run(id);
    })();
    return c.json({ ok: true });
  });

  app.post("/api/money/btc/sync", async (c) => {
    try { return c.json(await sync()); }
    catch (e) { return c.json({ error: /Set the address server/.test((e as Error).message) ? (e as Error).message : `Couldn't finish the sync: ${(e as Error).message}. What was already found is kept.` }, 502); }
  });

  return { sync, hasWallets: () => Boolean(base("api") && db.prepare("SELECT 1 FROM btc_wallet").get()) };
}
