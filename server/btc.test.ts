import { describe, expect, it, afterEach, vi } from "vitest";
import { HDKey } from "@scure/bip32";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { addressOf, parseKey } from "./btc.ts";

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
    expect((await month("2026-05"))[0]).toMatchObject({ description: "Bitcoin sent", amount: -120.6, category: "Other" });
    // The move doesn't count as income or spending.
    const s = await (await call("GET", "/api/money/summary?month=2026-04")).json();
    expect([s.in, s.out]).toEqual([0, 0]);

    // A label and a category he sets survive the next sync, and nothing is doubled.
    const sent = (await month("2026-05"))[0];
    await call("PATCH", `/api/money/tx/${sent.id}`, { category: "Business", note: "Camera lens from the shop" });
    expect(await (await call("POST", "/api/money/btc/sync")).json()).toMatchObject({ transactions: 0 });
    expect((await month("2026-05"))[0]).toMatchObject({ category: "Business", note: "Camera lens from the shop" });

    // Addresses only ever went to the address server; the price source saw no address.
    expect(asked.filter((u) => u.includes("/address/")).every((u) => u.startsWith("http://mempool.local:3006/"))).toBe(true);
    expect(asked.filter((u) => u.startsWith("http://prices.example")).every((u) => !/bc1|address/.test(u))).toBe(true);

    await call("DELETE", `/api/money/btc/wallets/${v.wallets[1].id}`);
    expect((await month("2026-04")).map((t: any) => t.account)).toEqual(["Spending"]);
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
    // "That deposit wasn't a transfer": both sides are released and it stays how I set it.
    await app.request(`/api/money/tx/${by("DEPOSIT").id}`, { method: "PATCH", headers: { ...J, cookie }, body: JSON.stringify({ category: "Income" }) });
    await imp("Savings", ["2026-10-20,ANOTHER LINE,-1"]);
    const again = (await (await app.request("/api/money/tx?month=2026-10", { headers: { cookie } })).json()).tx as any[];
    expect(again.find((t) => t.description === "DEPOSIT")).toMatchObject({ category: "Income", pair: null });
  });
});
