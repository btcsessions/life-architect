import { describe, expect, it, afterEach, vi } from "vitest";
import { HDKey } from "@scure/bip32";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { addressOf, parseKey, parseMulti, walletAddresses } from "./btc.ts";

const J = { "content-type": "application/json" };
afterEach(() => vi.unstubAllGlobals());
const ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("bitcoin keys", () => {
  it("derives the published BIP84 test addresses from a zpub", () => {
    const k = parseKey(ZPUB);
    expect(k.type).toBe("wpkh");
    expect(addressOf(k.hd, "wpkh", 0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(addressOf(k.hd, "wpkh", 0, 1)).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(addressOf(k.hd, "wpkh", 1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });
  it("reads descriptors, and refuses private keys, multisig and typos", () => {
    expect(parseKey(`wpkh([d34db33f/84h/0h/0h]${parseKey(ZPUB).xpub}/0/*)`).type).toBe("wpkh");
    expect(parseKey(parseKey(ZPUB).xpub).type).toBeNull(); // a bare xpub doesn't say
    expect(() => parseKey("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi")).toThrow(/private/);
    expect(() => parseKey(ZPUB.slice(0, -2) + "zz")).toThrow(/typo/);
    expect(() => parseKey("hello")).toThrow();
  });
});

describe("multisig descriptors", () => {
  const seeds = [3, 4, 5].map((n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n)).derive("m/48'/0'/0'/2'"));
  const xp = seeds.map((k) => k.publicExtendedKey);
  // Worked out here without the address library: the 2-of-3 script, hashed, as a bech32 address.
  const byHand = async (pubs: Uint8Array[]) => {
    const { bech32 } = await import("@scure/base");
    const { createHash } = await import("node:crypto");
    const script = Buffer.concat([Buffer.from([0x52]), ...pubs.map((p) => Buffer.concat([Buffer.from([33]), Buffer.from(p)])), Buffer.from([0x53, 0xae])]);
    return bech32.encode("bc", [0, ...bech32.toWords(createHash("sha256").update(script).digest())]);
  };
  const sortedPubs = (chain: number, i: number) => seeds.map((k) => k.deriveChild(chain).deriveChild(i).publicKey!).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  it("reads the usual shapes and builds the right addresses", async () => {
    const one = parseMulti(`wsh(sortedmulti(2,[aaaaaaaa/48'/0'/0'/2']${xp[0]}/<0;1>/*,[bbbbbbbb/48h/0h/0h/2h]${xp[1]}/<0;1>/*,[cccccccc/48h/0h/0h/2h]${xp[2]}/<0;1>/*))#abcd1234`);
    expect(one).toMatchObject({ script: "wsh", m: 2, sorted: true, chains: [[0], [1]] });
    const w = walletAddresses({ xpub: "x", type: "multi-wsh", spec: JSON.stringify(one) });
    expect(w.at(0, 0)).toBe(await byHand(sortedPubs(0, 0)));
    expect(w.at(1, 7)).toBe(await byHand(sortedPubs(1, 7)));
    // Receive-only descriptor: change is assumed on /1. Receive and change pasted together: same wallet.
    const recv = `wsh(sortedmulti(2,${xp[0]}/0/*,${xp[1]}/0/*,${xp[2]}/0/*))`;
    expect(parseMulti(recv).chains).toEqual([[0], [1]]);
    expect(parseMulti(`${recv}\n${recv.replace(/\/0\/\*/g, "/1/*")}`).chains).toEqual([[0], [1]]);
    expect(walletAddresses({ xpub: "x", type: "m", spec: JSON.stringify(parseMulti(recv)) }).at(0, 0)).toBe(w.at(0, 0));
    // multi() keeps the order as written, so it's a different wallet unless the keys happen to be sorted.
    const unsorted = parseMulti(`wsh(multi(2,${xp[2]}/0/*,${xp[1]}/0/*,${xp[0]}/0/*))`);
    expect(unsorted.sorted).toBe(false);
    // The wrapped kinds make 3… addresses.
    expect(walletAddresses({ xpub: "x", type: "m", spec: JSON.stringify(parseMulti(`sh(wsh(sortedmulti(2,${xp[0]}/0/*,${xp[1]}/0/*)))`)) }).at(0, 0)).toMatch(/^3/);
    expect(walletAddresses({ xpub: "x", type: "m", spec: JSON.stringify(parseMulti(`sh(sortedmulti(1,${xp[0]}/0/*,${xp[1]}/0/*))`)) }).at(0, 0)).toMatch(/^3/);
  });
  it("refuses what it can't follow", () => {
    expect(() => parseMulti(`wsh(sortedmulti(4,${xp[0]}/0/*,${xp[1]}/0/*))`)).toThrow(/add up/);
    expect(() => parseMulti(`wsh(sortedmulti(2,${xp[0]}/0h/*,${xp[1]}/0/*))`)).toThrow(/hardened/);
    expect(() => parseMulti(`wsh(sortedmulti(2,${xp[0]}/0/5,${xp[1]}/0/5))`)).toThrow(/\/\*/);
    expect(() => parseMulti("tr(abc)")).toThrow();
  });
});

describe("bitcoin wallets in Money", () => {
  it("tracks balances, values receipts in CAD on the day, and sees moves between my own wallets as transfers", async () => {
    const A = HDKey.fromMasterSeed(new Uint8Array(32).fill(1)).derive("m/84'/0'/0'"), B = HDKey.fromMasterSeed(new Uint8Array(32).fill(2)).derive("m/84'/0'/0'");
    const a = (c: number, i: number) => addressOf(A, "wpkh", c, i), b = (c: number, i: number) => addressOf(B, "wpkh", c, i);
    const T = (d: string) => Date.parse(`${d}T15:00:00Z`) / 1000;
    const txs = [
      { txid: "t1", fee: 300, status: { confirmed: true, block_time: T("2026-03-10") }, vin: [{ prevout: { scriptpubkey_address: "bc1qclient", value: 1_000_300 } }], vout: [{ scriptpubkey_address: a(0, 0), value: 1_000_000 }] },
      { txid: "t2", fee: 1000, status: { confirmed: true, block_time: T("2026-04-02") }, vin: [{ prevout: { scriptpubkey_address: a(0, 0), value: 1_000_000 } }], vout: [{ scriptpubkey_address: b(0, 0), value: 400_000 }, { scriptpubkey_address: a(1, 0), value: 599_000 }] },
      { txid: "t3", fee: 500, status: { confirmed: true, block_time: T("2026-05-20") }, vin: [{ prevout: { scriptpubkey_address: a(1, 0), value: 599_000 } }], vout: [{ scriptpubkey_address: "bc1qshop", value: 100_000 }, { scriptpubkey_address: a(1, 1), value: 498_500 }] },
      { txid: "t4", status: { confirmed: false }, vin: [{ prevout: { scriptpubkey_address: "bc1qclient", value: 50_000 } }], vout: [{ scriptpubkey_address: b(0, 1), value: 50_000 }] },
    ];
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(url);
      const u = new URL(url);
      let body: unknown = [];
      if (u.pathname.endsWith("/v1/historical-price")) body = { prices: [{ time: T("2026-03-10"), CAD: 100_000 }, { time: T("2026-04-02"), CAD: 110_000 }, { time: T("2026-05-20"), CAD: 120_000 }] };
      else if (u.pathname.endsWith("/v1/prices")) body = { CAD: 125_000 };
      else if (u.pathname.endsWith("/blocks/tip/height")) body = 900000;
      else { const addr = u.pathname.split("/address/")[1]?.split("/")[0]; body = txs.filter((t) => t.vin.some((i) => i.prevout.scriptpubkey_address === addr) || t.vout.some((o) => o.scriptpubkey_address === addr)); }
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 12, 0, 0));
    const cookie = (await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) })).headers.get("set-cookie")!.split(";")[0];
    const call = async (method: string, path: string, body?: unknown) => (await app.request(path, { method, headers: { ...J, cookie }, body: body === undefined ? undefined : JSON.stringify(body) }));
    expect((await app.request("/api/money/btc")).status).toBe(423); // behind the PIN
    expect((await call("POST", "/api/money/btc/sync")).status).toBe(502); // no server set yet
    expect((await (await call("PUT", "/api/money/btc/config", { api: "http://mempool.local:3006/api", price_api: "http://prices.example/api", test: true })).json()).api_is_public).toBe(false);
    // A bare xpub: the address type is found by looking for the one that's been used.
    const added = await (await call("POST", "/api/money/btc/wallets", { label: "Spending", key: A.publicExtendedKey })).json();
    expect(added).toMatchObject({ type: "wpkh", first_address: a(0, 0) });
    await call("POST", "/api/money/btc/wallets", { label: "Taxes", key: B.publicExtendedKey, type: "wpkh" });
    expect((await call("POST", "/api/money/btc/wallets", { label: "Spending", key: ZPUB })).status).toBe(409);
    const M = [7, 8].map((n) => HDKey.fromMasterSeed(new Uint8Array(32).fill(n)).derive("m/48'/0'/0'/2'").publicExtendedKey);
    const vault = await (await call("POST", "/api/money/btc/wallets", { label: "Vault", key: `wsh(sortedmulti(2,[11111111/48h/0h/0h/2h]${M[0]}/<0;1>/*,[22222222/48h/0h/0h/2h]${M[1]}/<0;1>/*))` })).json();
    expect(vault).toMatchObject({ signers: "2 of 2", type: "multi-wsh" });
    expect(vault.first_address).toMatch(/^bc1q.{58}$/); // a script address, longer than a single-key one
    expect((await call("POST", "/api/money/btc/wallets", { label: "Vault again", key: `wsh(sortedmulti(2,${M[0]}/<0;1>/*,${M[1]}/<0;1>/*))` })).status).toBe(409);
    await call("DELETE", `/api/money/btc/wallets/${vault.id}`);

    expect(await (await call("POST", "/api/money/btc/sync")).json()).toEqual({ wallets: 2, transactions: 4, transfers: 1 });
    const v = await (await call("GET", "/api/money/btc")).json();
    expect(v.wallets.map((w: any) => [w.label, w.sats, w.cad, w.pending])).toEqual([["Spending", 498_500, 623.13, 0], ["Taxes", 450_000, 562.5, 1]]);
    expect(v.total_sats).toBe(948_500);
    expect(JSON.stringify(v)).not.toContain(A.publicExtendedKey); // the key isn't sent back

    const month = async (m: string) => (await (await call("GET", `/api/money/tx?month=${m}`)).json()).tx;
    expect((await month("2026-03"))[0]).toMatchObject({ description: "Bitcoin received", amount: 1000, category: "Income", account: "Spending", sats: 1_000_000 });
    const april = await month("2026-04");
    expect(april.map((t: any) => [t.account, t.description, t.amount, t.category]).sort()).toEqual([
      ["Spending", "Bitcoin moved to Taxes", -441.1, "Transfers"],
      ["Taxes", "Bitcoin moved from Spending", 440, "Transfers"],
    ]);
    expect(april[0].pair.account).toBeTruthy();
    // By default a send that isn't to one of my wallets is paying down debt, not spending.
    expect((await month("2026-05"))[0]).toMatchObject({ description: "Bitcoin sent", amount: -120.6, category: "Transfers", pair: null });
    expect((await (await call("GET", "/api/money/summary?month=2026-05")).json()).out).toBe(0);
    // Switched off, it counts as spending again; switched back on, it doesn't.
    await call("PUT", "/api/money/btc/config", { sends_are_payments: false });
    expect((await month("2026-05"))[0].category).toBe("Other");
    expect((await (await call("GET", "/api/money/summary?month=2026-05")).json()).out).toBeCloseTo(120.6);
    await call("PUT", "/api/money/btc/config", { sends_are_payments: true });
    expect((await month("2026-05"))[0].category).toBe("Transfers");
    // A card statement arrives with a payment for nearly the same dollars two days later: matched without being asked.
    const amex = new FormData(); amex.set("file", new File(["Date,Description,Amount\n2026-05-22,PAYMENT RECEIVED - THANK YOU,121.00"], "a.csv")); amex.set("account", "Amex");
    expect((await (await app.request("/api/money/import", { method: "POST", headers: { cookie }, body: amex })).json()).transfers).toBe(1);
    const btcSend = async () => (await month("2026-05")).find((t: any) => t.description === "Bitcoin sent");
    expect(await btcSend()).toMatchObject({ category: "Transfers", pair: { account: "Amex" } });
    // The move doesn't count as income or spending.
    const s = await (await call("GET", "/api/money/summary?month=2026-04")).json();
    expect([s.in, s.out]).toEqual([0, 0]);

    // A label and a category he sets survive the next sync, and nothing is doubled.
    const sent = await btcSend();
    await call("PATCH", `/api/money/tx/${sent.id}`, { category: "Business", note: "Camera lens from the shop" });
    expect(await (await call("POST", "/api/money/btc/sync")).json()).toMatchObject({ transactions: 0 });
    expect(await btcSend()).toMatchObject({ category: "Business", note: "Camera lens from the shop", pair: null }); // and saying it wasn't a transfer splits the pair

    // Bitcoin that paid off a card is a transfer, not spending. The card's payment line is a little different in
    // dollars (conversion), and is found automatically when it reads like a payment.
    const visa = new FormData(); visa.set("file", new File(["Date,Description,Amount\n2026-05-21,PAYMENT - THANK YOU,118.00\n2026-05-22,CAMERA STORE,-300"], "v.csv")); visa.set("account", "Visa");
    await app.request("/api/money/tx/" + sent.id, { method: "PATCH", headers: { ...J, cookie }, body: JSON.stringify({ category: "Other" }) });
    const before = await (await call("GET", "/api/money/summary?month=2026-05")).json();
    expect(before.out).toBeCloseTo(120.6);
    await app.request("/api/money/import", { method: "POST", headers: { cookie }, body: visa });
    let may = await month("2026-05");
    expect(may.find((t: any) => t.description === "Bitcoin sent").pair).toBeNull(); // he'd set its type himself, so it's left alone
    const paid = await (await call("POST", `/api/money/tx/${sent.id}/paid`, { account: "Visa" })).json();
    expect(paid.matched).toMatchObject({ day: "2026-05-21", amount: 118 });
    may = await month("2026-05");
    expect(may.find((t: any) => t.description === "Bitcoin sent")).toMatchObject({ category: "Transfers", pair: { account: "Visa" } });
    const after = await (await call("GET", "/api/money/summary?month=2026-05")).json();
    expect(after.out).toBe(300); // only the camera store is spending now
    expect(after.in).toBe(0);

    // Addresses only ever went to the address server; the price source saw no address.
    expect(asked.filter((u) => u.includes("/address/")).every((u) => u.startsWith("http://mempool.local:3006/"))).toBe(true);
    expect(asked.filter((u) => u.startsWith("http://prices.example")).every((u) => !/bc1|address/.test(u))).toBe(true);

    await call("DELETE", `/api/money/btc/wallets/${v.wallets[1].id}`);
    expect((await month("2026-04")).map((t: any) => t.account)).toEqual(["Spending"]);
  });
});

describe("my own transaction types", () => {
  it("adds, uses, renames and removes a type", async () => {
    const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 12, 0, 0));
    const cookie = (await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) })).headers.get("set-cookie")!.split(";")[0];
    const call = async (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...J, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const f = new FormData(); f.set("file", new File(["Date,Description,Amount\n2026-11-02,B&H PHOTO,-900\n2026-11-03,ZZ UNKNOWN,-20"], "s.csv")); f.set("account", "Visa");
    await app.request("/api/money/import", { method: "POST", headers: { cookie }, body: f });
    expect((await call("POST", "/api/money/categories", { name: "food" })).status).toBe(409); // built-in, any case
    const added = await (await call("POST", "/api/money/categories", { name: "Camera gear" })).json();
    expect(added.categories.slice(-4)).toEqual(["Camera gear", "Income", "Transfers", "Other"]);
    const tx = (await (await call("GET", "/api/money/tx?month=2026-11")).json()).tx as any[];
    const lens = tx.find((t) => t.description === "B&H PHOTO");
    expect((await call("PATCH", `/api/money/tx/${lens.id}`, { category: "Camera gear", always: true })).status).toBe(200);
    let sum = await (await call("GET", "/api/money/summary?month=2026-11")).json();
    expect(sum.categories.find((c: any) => c.name === "Camera gear").total).toBe(900);
    await call("PATCH", "/api/money/categories/Camera%20gear", { to: "Gear" });
    sum = await (await call("GET", "/api/money/summary?month=2026-11")).json();
    expect(sum.categories.map((c: any) => c.name)).toContain("Gear");
    expect((await call("DELETE", "/api/money/categories/Food")).status).toBe(404); // built-ins stay
    await call("DELETE", "/api/money/categories/Gear");
    sum = await (await call("GET", "/api/money/summary?month=2026-11")).json();
    expect(sum.categories.map((c: any) => c.name)).toEqual(["Other"]);
  });
});

describe("what I own", () => {
  it("values stocks by ticker in CAD, shows home equity after what's owing, and totals it", async () => {
    const asked: string[] = [];
    let limited = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(url);
      const u = new URL(url), fn = u.searchParams.get("function"), sym = u.searchParams.get("symbol");
      let body: unknown = {};
      if (limited) body = { Information: "We have detected your API key and our standard API rate limit is 25 requests per day." };
      else if (sym === "BURST" && !asked.slice(0, -1).some((x) => x.includes("BURST"))) body = { Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." };
      else if (sym === "BURST") body = { "Global Quote": { "05. price": "3.00" } };
      else if (sym === "PAID.TRV") body = { Information: "This is a premium endpoint. Subscribe to a premium plan." };
      else if (fn === "CURRENCY_EXCHANGE_RATE") body = { "Realtime Currency Exchange Rate": { "5. Exchange Rate": "1.4000" } };
      else if (fn === "SYMBOL_SEARCH") body = { bestMatches: [{ "1. symbol": "BTCW", "2. name": "WisdomTree Bitcoin Fund", "3. type": "ETF", "4. region": "United States", "8. currency": "USD" }, { "1. symbol": "BTCW.TRV", "2. name": "Bitcoin Well Inc", "3. type": "Equity", "4. region": "Toronto Venture", "8. currency": "CAD" }] };
      else if (sym === "BTCW") body = { "Global Quote": { "05. price": "90.00" } };
      else if (sym === "BTCW.TRV") body = { "Global Quote": { "05. price": "0.20" } };
      else if (fn === "GLOBAL_QUOTE") body = { "Global Quote": sym === "AAPL" ? { "01. symbol": "AAPL", "05. price": "200.0000" } : sym === "SHOP.TRT" ? { "05. price": "150.50" } : {} };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 12, 0, 0));
    const cookie = (await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) })).headers.get("set-cookie")!.split(";")[0];
    const call = async (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...J, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    // Without a key: added, priced by hand or not at all, nothing fetched.
    expect(await (await call("POST", "/api/money/assets", { ticker: "aapl", shares: "10" })).json()).toMatchObject({ priced: false });
    expect(asked).toHaveLength(0);
    await call("PUT", "/api/money/assets/quote-key", { key: "KEY123" });
    await call("POST", "/api/money/assets", { ticker: "SHOP.TRT", shares: 4 });
    expect((await call("POST", "/api/money/assets", { ticker: "NOPE", shares: 1 })).status).toBe(200);
    await call("POST", "/api/money/assets", { name: "Home", kind: "Property", value: "650,000", owing: "410,000" });
    expect((await call("POST", "/api/money/assets", { ticker: "AAPL", shares: 0 })).status).toBe(400);
    let v = await (await call("GET", "/api/money/assets")).json();
    const by = (n: string) => v.assets.find((a: any) => a.name === n);
    expect(by("AAPL")).toMatchObject({ value: 2800, currency: "USD", price: 200 }); // 10 x 200 x 1.40
    expect(by("SHOP.TRT")).toMatchObject({ value: 602, currency: "CAD" });
    expect(by("NOPE")).toMatchObject({ value: 0, price: null });
    expect(by("Home")).toMatchObject({ value: 650000, owing: 410000, equity: 240000 });
    expect(v.totals).toEqual({ value: 653402, owing: 410000, net: 243402 });
    expect(JSON.stringify(v)).not.toContain("KEY123");
    // Only tickers went out: never share counts or values.
    expect(asked.every((u) => u.startsWith("https://www.alphavantage.co/query?") && !/shares|2800|650000/.test(u))).toBe(true);
    // Paying the mortgage down and changing a holding.
    await call("PATCH", `/api/money/assets/${by("Home").id}`, { value: 650000, owing: 400000 });
    await call("PATCH", `/api/money/assets/${by("AAPL").id}`, { shares: 20 });
    await call("PATCH", `/api/money/assets/${by("NOPE").id}`, { shares: 1, price: 12.5 });
    v = await (await call("GET", "/api/money/assets")).json();
    expect(by("Home").equity).toBe(250000);
    expect(by("AAPL").value).toBe(5600);
    expect(by("NOPE").value).toBe(17.5); // typed in by hand, in USD at the stored rate
    // The bare symbol matched a different company. Search shows which is which, and the holding can be re-pointed.
    await call("POST", "/api/money/assets", { ticker: "BTCW", shares: 1000 });
    v = await (await call("GET", "/api/money/assets")).json();
    expect(by("BTCW").value).toBe(126000); // priced as the US fund, in USD: wrong
    const found = await (await call("POST", "/api/money/assets/search", { q: "BTCW" })).json();
    expect(found.matches[1]).toEqual({ symbol: "BTCW.TRV", name: "Bitcoin Well Inc", type: "Equity", region: "Toronto Venture", currency: "CAD" });
    await call("PATCH", `/api/money/assets/${by("BTCW").id}`, { ticker: "btcw.trv", name: "Bitcoin Well Inc", currency: "CAD" });
    v = await (await call("GET", "/api/money/assets")).json();
    expect(by("Bitcoin Well Inc")).toMatchObject({ ticker: "BTCW.TRV", currency: "CAD", price: 0.2, value: 200, shares: 1000 });
    await call("DELETE", `/api/money/assets/${by("Bitcoin Well Inc").id}`);

    // "One a second" is waited out and retried; "needs a paid plan" is reported for that ticker only.
    expect(await (await call("POST", "/api/money/assets", { ticker: "BURST", shares: 2, currency: "CAD" })).json()).toMatchObject({ priced: true });
    const paid = await (await call("POST", "/api/money/assets", { ticker: "PAID.TRV", shares: 100 })).json();
    expect(paid).toMatchObject({ priced: false, limited: false });
    expect(paid.failed[0]).toContain("paid plan");
    // When the service says slow down, what's stored is kept and he's told.
    limited = true;
    const r = await (await call("POST", "/api/money/assets/refresh")).json();
    expect(r).toMatchObject({ limited: true, updated: 0 });
    expect(r.note).toContain("limit for today");
    expect(r.assets.find((a: any) => a.name === "AAPL").value).toBe(5600);
  });
});

describe("transfers between my own accounts", () => {
  it("pairs a chequing-to-savings move and a card payment, leaves look-alikes alone, and lets me undo one", async () => {
    const app = createApp(openDb(":memory:"), () => new Date(2026, 10, 19, 12, 0, 0));
    const cookie = (await app.request("/api/money/pin", { method: "POST", headers: J, body: JSON.stringify({ pin: "246810" }) })).headers.get("set-cookie")!.split(";")[0];
    const imp = async (account: string, lines: string[]) => { const f = new FormData(); f.set("file", new File(["Date,Description,Amount\n" + lines.join("\n")], "s.csv")); f.set("account", account); return (await app.request("/api/money/import", { method: "POST", headers: { cookie }, body: f })).json(); };
    await imp("Chequing", ["2026-10-03,ONLINE TRANSFER TO 12345,-500", "2026-10-10,VISA PAYMENT,-1204.11", "2026-10-12,COFFEE ROASTERS,-50", "2026-10-15,PAYROLL DEPOSIT,3000"]);
    expect((await imp("Savings", ["2026-10-04,DEPOSIT,500", "2026-10-13,BONUS INTEREST,50"])).transfers).toBe(1);
    expect((await imp("Visa", ["2026-10-12,PAYMENT - THANK YOU,1204.11", "2026-10-14,AMAZON.CA,-64.20"])).transfers).toBe(1);
    const tx = (await (await app.request("/api/money/tx?month=2026-10", { headers: { cookie } })).json()).tx as any[];
    const by = (d: string) => tx.find((t) => t.description === d);
    expect(by("ONLINE TRANSFER TO 12345")).toMatchObject({ category: "Transfers", pair: { account: "Savings" } });
    expect(by("DEPOSIT")).toMatchObject({ category: "Transfers", pair: { account: "Chequing" } });
    expect(by("VISA PAYMENT").pair.account).toBe("Visa");
    expect(by("COFFEE ROASTERS").pair).toBeNull(); // same $50 as the interest, but neither is a transfer
    expect(by("BONUS INTEREST").category).not.toBe("Transfers");
    const s = await (await app.request("/api/money/summary?month=2026-10", { headers: { cookie } })).json();
    expect(s.in).toBe(3050);
    expect(s.out).toBeCloseTo(114.2);
    // A card statement read the wrong way round: flip the account, and a re-import still adds nothing.
    await imp("Amex", ["2026-10-06,GROCERY STORE,82.14", "2026-10-07,HARDWARE SHOP,40"]);
    const flipped = await (await app.request("/api/money/flip", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify({ account: "Amex", month: "2026-10" }) })).json();
    expect(flipped).toEqual({ flipped: 2 });
    const amex = ((await (await app.request("/api/money/tx?month=2026-10", { headers: { cookie } })).json()).tx as any[]).filter((t) => t.account === "Amex");
    expect(amex.map((t) => [t.amount, t.category === "Income"])).toEqual([[-40, false], [-82.14, false]]);
    expect((await imp("Amex", ["2026-10-06,GROCERY STORE,82.14", "2026-10-07,HARDWARE SHOP,40"])).added).toBe(0);
    const one = amex[0];
    await app.request(`/api/money/tx/${one.id}`, { method: "PATCH", headers: { ...J, cookie }, body: JSON.stringify({ flip: true }) });

    // "That deposit wasn't a transfer": both sides are released and it stays how I set it.
    await app.request(`/api/money/tx/${by("DEPOSIT").id}`, { method: "PATCH", headers: { ...J, cookie }, body: JSON.stringify({ category: "Income" }) });
    await imp("Savings", ["2026-10-20,ANOTHER LINE,-1"]);
    const again = (await (await app.request("/api/money/tx?month=2026-10", { headers: { cookie } })).json()).tx as any[];
    expect(again.find((t) => t.description === "DEPOSIT")).toMatchObject({ category: "Income", pair: null });
  });
});
