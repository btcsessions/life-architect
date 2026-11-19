import { useCallback, useEffect, useState } from "react";
import { json } from "./api";
import { LockGate, type Session } from "./Lock";
import { ScreenHead, money } from "./ui";

interface Group { name: string; total: number; count: number }
interface Category extends Group { share: number; merchants: Group[] }
interface Summary {
  month: string; months: string[]; in: number; out: number; left: number;
  previous: { month: string; in: number; out: number; left: number } | null;
  categories: Category[]; income: Group[]; savings: Array<{ text: string; amount: number }>;
  tasks: Array<{ id: number; title: string; due: string | null }>; count: number; unsorted: number; has_model: boolean;
}
interface Tx { id: number; day: string; description: string; merchant: string; amount: number; category: string; account: string | null; file_id: number | null; note: string | null; sats: number | null; pair: { account: string | null; day: string } | null }
type Props = { onBack: () => void; onError: (m: string) => void };

const COLORS = ["#f7931a", "#7ed3f2", "#7ef2a8", "#3fa8d4", "#ffb35c", "#b8bdcc", "#c46f0a", "#8a90a3", "#e879a6", "#a78bfa", "#f2e27e", "#4fd1b5", "#ff6b5e", "#9fb4ff", "#d4a373", "#6ee7f0"];
const monthName = (m: string) => new Date(m + "-15T12:00:00").toLocaleDateString("en", { month: "long", year: "numeric" });
const change = (now: number, before: number) => (before ? `${now >= before ? "+" : "−"}${Math.abs(Math.round(((now - before) / before) * 100))}% vs ${""}` : "");

export function Money({ onBack, onError }: Props) {
  return (
    <LockGate name="money" title="Money" onBack={onBack} note="Figures stay behind this PIN. The deck only ever shows Money's task names.">
      {(s) => <Dashboard s={s} onBack={onBack} onError={onError} />}
    </LockGate>
  );
}

function Dashboard({ s, onBack, onError }: { s: Session } & Props) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [month, setMonth] = useState<string | undefined>();
  const [cat, setCat] = useState<string | null>(null);
  const [dig, setDig] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => s.call<Summary>(`/api/money/summary${month ? `?month=${month}` : ""}`).then(setSum).catch((e) => onError(e.message)), [s, month, onError]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };

  if (!sum) return <p className="muted">Loading…</p>;
  const empty = sum.count === 0;
  const selected = sum.categories.find((c) => c.name === cat) ?? null;
  const C = 2 * Math.PI * 25;
  let offset = 0;

  return (
    <div className="stack">
      <ScreenHead title="Money" eyebrow={monthName(sum.month)} onBack={onBack} right={
        <>
          {sum.months.length > 1 && (
            <select className="inline" aria-label="Month" value={sum.month} onChange={(e) => { setMonth(e.target.value); setCat(null); }}>
              {sum.months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            </select>
          )}
          <button className="btn" onClick={s.lock}>Lock now</button>
        </>
      } />

      {sum.tasks.length > 0 && (
        <section className="card pad">
          <span className="eyebrow accent">Needs you · {sum.tasks.length}</span>
          <ul className="list">{sum.tasks.map((t) => <li key={t.id}><span className="dot" /><span className="grow">{t.title}</span>{t.due && <span className="muted small">Due {t.due}</span>}</li>)}</ul>
        </section>
      )}

      {empty ? (
        <section className="card pad"><p className="muted">Nothing here yet. Import a bank or card statement below and this fills in.</p></section>
      ) : (
        <>
          <section className="stats">
            <div className="card stat"><span className="eyebrow">In</span><span className="big">{money(sum.in)}</span>{sum.previous && <span className="muted small">{change(sum.in, sum.previous.in)}{monthName(sum.previous.month)}</span>}</div>
            <div className="card stat"><span className="eyebrow">Out</span><span className="big">{money(sum.out)}</span>{sum.previous && <span className="muted small">{change(sum.out, sum.previous.out)}{monthName(sum.previous.month)}</span>}</div>
            <div className="card stat hot"><span className="eyebrow accent">Left over</span><span className="big">{money(sum.left)}</span><span className="muted small">The one number to watch</span></div>
          </section>

          <div className="grid-2">
            <section className="card pad stack">
              <span className="eyebrow">Where it's going</span>
              {sum.categories.length === 0 ? <p className="muted small">No spending this month.</p> : (
                <div className="pie-wrap">
                  <svg className="pie" role="img" aria-label="Spending by category" width="200" height="200" viewBox="0 0 100 100">
                    {sum.categories.map((c, i) => {
                      const len = c.share * C;
                      const el = <circle key={c.name} cx="50" cy="50" r="25" fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="50" strokeDasharray={`${Math.max(len - 0.5, 0.2)} ${C}`} strokeDashoffset={-offset} opacity={!cat || cat === c.name ? 1 : 0.3} onClick={() => setCat(cat === c.name ? null : c.name)} />;
                      offset += len;
                      return el;
                    })}
                  </svg>
                  <ul className="legend">
                    {sum.categories.map((c, i) => (
                      <li key={c.name}>
                        <button aria-pressed={cat === c.name} onClick={() => setCat(cat === c.name ? null : c.name)}>
                          <span className="swatch" style={{ background: COLORS[i % COLORS.length] }} />
                          <span className="grow">{c.name}</span>
                          <span className="muted">{money(c.total)} · {Math.round(c.share * 100)}%</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selected && (
                <div className="sub">
                  <div className="row"><span className="module-name grow">Inside {selected.name}</span><button className="btn ghost" onClick={() => setCat(null)}>Close</button></div>
                  <ul className="list">{selected.merchants.map((m) => <li key={m.name}><span className="grow">{m.name}{m.count > 1 && <span className="muted small"> · {m.count} times</span>}</span><span className="muted">{money(m.total)}</span></li>)}</ul>
                  <button className="linkish" onClick={() => setDig("tx")}>See these transactions below</button>
                </div>
              )}
            </section>

            <section className="card pad stack hot">
              <span className="eyebrow accent">Where you could save</span>
              {sum.savings.length === 0 ? <p className="muted small">Nothing stands out yet. This looks for charges that repeat, creep up, or appear twice, and needs about three months of statements to be useful.</p> : (
                <ul className="list">{sum.savings.map((x, i) => <li key={i}><span className="grow">{x.text}</span><span className="accent">{money(x.amount)}</span></li>)}</ul>
              )}
              {sum.unsorted > 0 && (
                <div className="stack">
                  <p className="muted small">{sum.unsorted} transaction{sum.unsorted === 1 ? "" : "s"} couldn't be sorted and sit under "Other".</p>
                  {sum.has_model && <button className="btn" onClick={() => act(async () => { const r = await s.call<{ sorted: number }>("/api/money/sort", { method: "POST" }); setNote(`Sorted ${r.sorted}. Only merchant names were sent to the model.`); })}>Sort them with Money's model</button>}
                </div>
              )}
              {note && <p className="small electro" role="status">{note}</p>}
            </section>
          </div>

          <section className="stack">
            <span className="eyebrow">Dig deeper · only if you want to</span>
            <Dig title="Income" total={money(sum.in)} open={dig === "income"} onToggle={() => setDig(dig === "income" ? null : "income")}>
              <ul className="list">{sum.income.map((g) => <li key={g.name}><span className="grow">{g.name}</span><span className="amount-in">{money(g.total)}</span></li>)}</ul>
            </Dig>
            <Dig title="Investments & assets" total="" open={dig === "assets"} onToggle={() => setDig(dig === "assets" ? null : "assets")}>
              <Assets s={s} onError={onError} />
            </Dig>
            <div className="row">
              <button className="btn" onClick={() => s.call<{ pairs: number; total: number; unnamed: number }>("/api/money/transfers/sweep", { method: "POST" }).then((r) => { setNote(`${r.pairs ? `Found ${r.pairs} new transfer${r.pairs === 1 ? "" : "s"}` : "No new transfers found"} (${r.total} matched in all).${r.unnamed ? ` ${r.unnamed} transaction${r.unnamed === 1 ? " has" : "s have"} no account name, so ${r.unnamed === 1 ? "it" : "they"} can't be matched.` : ""}`); load(); }).catch((e) => onError(e.message))}>Check for transfers between my accounts</button>
              {note && /transfer/.test(note) && <span className="small electro" role="status">{note}</span>}
            </div>
            <Dig title="Every transaction" total={`${sum.count} this month`} open={dig === "tx"} onToggle={() => setDig(dig === "tx" ? null : "tx")}>
              <Transactions s={s} month={sum.month} category={cat} onChanged={load} onError={onError} />
            </Dig>
          </section>
        </>
      )}

      <Bitcoin s={s} onChanged={load} onError={onError} />
      <Feed s={s} onDone={(m) => { setNote(m); setMonth(undefined); load(); }} onError={onError} />
      {empty && note && <p className="small electro" role="status">{note}</p>}
    </div>
  );
}

function Dig({ title, total, open, onToggle, children }: { title: string; total: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="card">
      <button className="row-btn" aria-expanded={open} onClick={onToggle}>
        <span className="module-name grow">{title}</span><span className="muted">{total}</span><span aria-hidden="true" className="muted">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="dig-body">{children}</div>}
    </div>
  );
}

function Transactions({ s, month, category, onChanged, onError }: { s: Session; month: string; category: string | null; onChanged: () => void; onError: (m: string) => void }) {
  const [data, setData] = useState<{ tx: Tx[]; categories: string[]; custom: string[]; accounts: Array<{ account: string; n: number; wallet: number }> } | null>(null);
  const [labelling, setLabelling] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const [flipAcct, setFlipAcct] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [types, setTypes] = useState(false);
  const load = useCallback(() => s.call<{ tx: Tx[]; categories: string[]; custom: string[]; accounts: Array<{ account: string; n: number; wallet: number }> }>(`/api/money/tx?month=${month}${category ? `&category=${encodeURIComponent(category)}` : ""}`).then(setData).catch((e) => onError(e.message)), [s, month, category, onError]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="muted">Loading…</p>;
  const resort = async (t: Tx, cat: string) => {
    const always = t.sats === null && window.confirm(`Put everything from "${t.merchant}" in ${cat} from now on?\n\nOK: always. Cancel: just this one.`);
    try { await s.call(`/api/money/tx/${t.id}`, json("PATCH", { category: cat, always })); await load(); onChanged(); } catch (e) { onError((e as Error).message); }
  };
  const flipAll = async (m: string | null) => { try { const r = await s.call<{ flipped: number }>("/api/money/flip", json("POST", { account: flipAcct, month: m })); setFlipAcct(""); await load(); onChanged(); setMsg(`Flipped ${r.flipped} line${r.flipped === 1 ? "" : "s"}. Charges and money in are now the other way round for that account.`); } catch (e) { onError((e as Error).message); } };
  const saveLabel = async (t: Tx) => { try { await s.call(`/api/money/tx/${t.id}`, json("PATCH", { note: label })); setLabelling(null); await load(); } catch (e) { onError((e as Error).message); } };
  return (
    <>
      <button className="linkish" aria-expanded={types} onClick={() => setTypes(!types)}>Your own transaction types · {data.custom.length} {types ? "▾" : "▸"}</button>
      {types && (
        <div className="card pad form">
          <form className="row" onSubmit={(e) => { e.preventDefault(); s.call("/api/money/categories", json("POST", { name: type })).then(() => { setType(""); return load(); }).catch((er) => onError(er.message)); }}>
            <label htmlFor="newtype" className="sr">New type</label>
            <input id="newtype" className="plain-input grow" type="text" maxLength={30} placeholder="e.g. Kids, Gear, Software, Taxes" value={type} onChange={(e) => setType(e.target.value)} />
            <button className="btn" type="submit" disabled={!type.trim()}>Add type</button>
          </form>
          {data.custom.length > 0 && <div className="row">{data.custom.map((c) => <span key={c} className="status">{c} <button className="chip-x" aria-label={`Remove ${c}`} onClick={() => s.call(`/api/money/categories/${encodeURIComponent(c)}`, { method: "DELETE" }).then(() => { load(); onChanged(); }).catch((er) => onError(er.message))}>✕</button></span>)}</div>}
          <p className="muted small" style={{ margin: 0 }}>New types show in the list beside every transaction and get their own slice of the chart. Removing one sends its transactions back to Other.</p>
        </div>
      )}
      {data.accounts.length > 0 && (
        <div className="row">
          <select className="inline" aria-label="Account to flip" value={flipAcct} onChange={(e) => setFlipAcct(e.target.value)}><option value="">An account's charges show as income?</option>{data.accounts.map((a) => <option key={a.account} value={a.account}>{a.account} · {a.n} lines</option>)}</select>
          {flipAcct && <><button className="btn" onClick={() => flipAll(month)}>Flip {flipAcct} for this month</button><button className="btn ghost" onClick={() => flipAll(null)}>Flip all of {flipAcct}</button></>}
        </div>
      )}
      {msg && <p className="small electro" role="status">{msg}</p>}
      {category && <p className="muted small">Showing {category} only. Close the category above to see everything.</p>}
      <ul className="list">
        {data.tx.map((t) => (
          <li key={t.id}>
            <span className="grow">{t.note || t.merchant}
              <span className="muted small block">{t.day} · {t.description}{t.account ? ` · ${t.account}` : ""}{t.sats !== null ? ` · ${(Math.abs(t.sats) / 1e8).toFixed(8)} BTC` : ""}{t.file_id ? <> · <a href={`/api/money/files/${t.file_id}`} target="_blank" rel="noreferrer">receipt</a></> : null}</span>
              {!t.pair && t.sats !== null && t.amount < 0 && t.category === "Transfers" && <span className="small electro block">Counted as paying down debt · not spending. Change the type if this one was a purchase.</span>}
              {t.pair && <span className="small electro block">↔ Moved {t.amount < 0 ? "to" : "from"} {t.pair.account ?? "another account"} · not counted as {t.amount < 0 ? "spending" : "income"}</span>}
              {labelling === t.id ? (
                <span className="row" style={{ marginTop: 6 }}><input className="plain-input grow" type="text" aria-label="Label" placeholder="What was this?" value={label} onChange={(e) => setLabel(e.target.value)} /><button className="btn" onClick={() => saveLabel(t)}>Save</button><button className="btn ghost" onClick={() => setLabelling(null)}>Cancel</button></span>
              ) : (
                <span className="row" style={{ gap: 14 }}>
                  <button className="linkish small" onClick={() => { setLabelling(t.id); setLabel(t.note ?? ""); }}>{t.note ? "Change label" : "Add a label"}</button>
                  {t.amount < 0 && !t.pair && data.accounts.some((a) => !a.wallet && a.account !== t.account) && (
                    <select className="inline small" aria-label={`What ${t.note || t.merchant} paid off`} value="" onChange={(e) => { const account = e.target.value; if (!account) return; s.call<{ matched: { day: string; amount: number } | null }>(`/api/money/tx/${t.id}/paid`, json("POST", { account })).then((r) => { setMsg(r.matched ? `Counted as paying off ${account}, matched to its ${r.matched.day} payment of $${r.matched.amount.toFixed(2)}. It's no longer spending.` : `Counted as paying off ${account}. It's no longer spending. It'll link to the payment line when that statement is imported.`); load(); onChanged(); }).catch((er) => onError(er.message)); }}>
                      <option value="">This paid off…</option>{data.accounts.filter((a) => !a.wallet && a.account !== t.account).map((a) => <option key={a.account} value={a.account}>{a.account}</option>)}
                    </select>
                  )}
                  {t.sats === null && <button className="linkish small" onClick={() => s.call(`/api/money/tx/${t.id}`, json("PATCH", { flip: true })).then(() => { load(); onChanged(); }).catch((e) => onError(e.message))}>{t.amount > 0 ? "This was a charge, not money in" : "This was money in, not a charge"}</button>}
                </span>
              )}
            </span>
            <select className="inline" aria-label={`Category for ${t.merchant}`} value={t.category} onChange={(e) => resort(t, e.target.value)}>
              {data.categories.map((c) => <option key={c}>{c}</option>)}
            </select>
            <span className={t.amount > 0 ? "amount-in" : ""}>{money(t.amount)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

interface Holding { id: number; name: string; kind: string; value: number; owing: number; equity: number; updated_at: string; ticker: string | null; shares: number | null; currency: string | null; price: number | null; price_day: string | null }
interface Worth { assets: Holding[]; bitcoin: number | null; totals: { value: number; owing: number; net: number }; has_key: boolean; today: string }
const dollars = (n: number) => `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Assets({ s, onError }: { s: Session; onError: (m: string) => void }) {
  const [w, setW] = useState<Worth | null>(null);
  const [add, setAdd] = useState<null | "stock" | "home" | "other" | "key">(null);
  const [f, setF] = useState({ ticker: "", shares: "", currency: "", price: "", name: "", kind: "Property", value: "", owing: "", key: "" });
  const [edit, setEdit] = useState<number | null>(null);
  const [e, setE] = useState({ shares: "", price: "", value: "", owing: "" });
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => s.call<Worth>("/api/money/assets").then(setW).catch((er) => onError(er.message)), [s, onError]);
  useEffect(() => { load(); }, [load]);
  if (!w) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); } catch (er) { onError((er as Error).message); } finally { setBusy(false); } };
  const reset = () => { setF({ ticker: "", shares: "", currency: "", price: "", name: "", kind: "Property", value: "", owing: "", key: "" }); setAdd(null); };
  const quoteNote = (r: { limited?: boolean; failed?: string[]; updated?: number }) => r.limited ? "The price service has hit its daily limit. Prices will fill in tomorrow, or type one in." : r.failed?.length ? `No price found for ${r.failed.join(", ")}. Check the symbol, or type the price in.` : null;
  return (
    <div className="stack">
      <div className="stats">
        <div className="stat"><span className="eyebrow">Worth</span><span className="big">{money(w.totals.value)}</span></div>
        <div className="stat"><span className="eyebrow">Owing</span><span className="big">{money(w.totals.owing)}</span></div>
        <div className="stat"><span className="eyebrow accent">Net</span><span className="big">{money(w.totals.net)}</span></div>
      </div>
      <ul className="list">
        {w.bitcoin !== null && <li><span className="grow">Bitcoin wallets<span className="muted small block">From the Bitcoin section below · at the last price seen</span></span><span>{dollars(w.bitcoin)}</span></li>}
        {w.assets.map((a) => (
          <li key={a.id} style={{ flexWrap: "wrap" }}>
            <span className="grow">{a.name}
              <span className="muted small block">
                {a.ticker ? `${a.ticker} · ${a.shares} share${a.shares === 1 ? "" : "s"}${a.price ? ` @ ${a.currency === "USD" ? "US" : ""}$${a.price.toFixed(2)}` : " · no price yet"}${a.price_day ? ` · priced ${a.price_day}` : ""}`
                  : `${a.kind}${a.owing ? ` · worth ${dollars(a.value)} · owing ${dollars(a.owing)}` : ""} · updated ${a.updated_at}`}
              </span>
            </span>
            <span>{dollars(a.equity)}{a.owing > 0 && <span className="muted small block" style={{ textAlign: "right" }}>equity</span>}</span>
            <button className="btn ghost" onClick={() => { setEdit(edit === a.id ? null : a.id); setE({ shares: String(a.shares ?? ""), price: "", value: String(a.value), owing: String(a.owing || "") }); }}>Update</button>
            <button className="btn ghost" aria-label={`Remove ${a.name}`} onClick={() => act(() => s.call(`/api/money/assets/${a.id}`, { method: "DELETE" }))}>✕</button>
            {edit === a.id && (
              <form className="form" style={{ flexBasis: "100%" }} onSubmit={(ev) => { ev.preventDefault(); act(async () => { await s.call(`/api/money/assets/${a.id}`, json("PATCH", a.ticker ? { shares: e.shares, ...(e.price ? { price: e.price } : {}) } : { value: e.value, owing: e.owing })); setEdit(null); }); }}>
                <div className="fields">
                  {a.ticker ? (
                    <>
                      <label htmlFor={`es${a.id}`}>Shares<input id={`es${a.id}`} type="text" inputMode="decimal" value={e.shares} onChange={(ev) => setE({ ...e, shares: ev.target.value })} /></label>
                      <label htmlFor={`ep${a.id}`}>Price per share ({a.currency}), only to set it by hand<input id={`ep${a.id}`} type="text" inputMode="decimal" placeholder="leave blank to keep" value={e.price} onChange={(ev) => setE({ ...e, price: ev.target.value })} /></label>
                    </>
                  ) : (
                    <>
                      <label htmlFor={`ev${a.id}`}>Worth now<input id={`ev${a.id}`} type="text" inputMode="decimal" value={e.value} onChange={(ev) => setE({ ...e, value: ev.target.value })} /></label>
                      <label htmlFor={`eo${a.id}`}>Still owing on it<input id={`eo${a.id}`} type="text" inputMode="decimal" placeholder="0" value={e.owing} onChange={(ev) => setE({ ...e, owing: ev.target.value })} /></label>
                    </>
                  )}
                </div>
                <div className="row"><button className="btn" type="submit" disabled={busy}>Save</button><button className="btn ghost" type="button" onClick={() => setEdit(null)}>Cancel</button></div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="small electro" role="status" style={{ margin: 0 }}>{note}</p>}
      <div className="row">
        <button className="btn" onClick={() => setAdd(add === "stock" ? null : "stock")}>Add a stock</button>
        <button className="btn" onClick={() => { setAdd(add === "home" ? null : "home"); setF({ ...f, kind: "Property", name: f.name || "Home" }); }}>Add a home or property</button>
        <button className="btn" onClick={() => { setAdd(add === "other" ? null : "other"); setF({ ...f, kind: "Cash", name: "" }); }}>Add something else</button>
        {w.assets.some((a) => a.ticker) && w.has_key && <button className="btn ghost" disabled={busy} onClick={() => act(async () => { const r = await s.call<{ updated: number; limited: boolean; failed: string[] }>("/api/money/assets/refresh", { method: "POST" }); setNote(quoteNote(r) ?? `Prices updated for ${r.updated} holding${r.updated === 1 ? "" : "s"}.`); })}>{busy ? "Fetching…" : "Refresh prices"}</button>}
        <button className="btn ghost" onClick={() => setAdd(add === "key" ? null : "key")}>{w.has_key ? "Price key ✓" : "Set up stock prices"}</button>
      </div>
      {add === "stock" && (
        <form className="form" onSubmit={(ev) => { ev.preventDefault(); act(async () => { const r = await s.call<{ priced: boolean; limited: boolean; failed: string[] }>("/api/money/assets", json("POST", { ticker: f.ticker, shares: f.shares, currency: f.currency || undefined, price: f.price || undefined })); setNote(r.priced ? "Added." : quoteNote(r) ?? (w.has_key ? "Added. The price will fill in shortly." : "Added without a price. Set up stock prices, or use Update to type one in.")); reset(); }); }}>
          <div className="fields">
            <label htmlFor="st">Ticker<input id="st" type="text" required autoCapitalize="characters" placeholder="AAPL, or SHOP.TRT for Toronto" value={f.ticker} onChange={(ev) => setF({ ...f, ticker: ev.target.value })} /></label>
            <label htmlFor="sh">Shares<input id="sh" type="text" inputMode="decimal" required value={f.shares} onChange={(ev) => setF({ ...f, shares: ev.target.value })} /></label>
            <label htmlFor="sc">Priced in<select id="sc" value={f.currency} onChange={(ev) => setF({ ...f, currency: ev.target.value })}><option value="">Work it out from the ticker</option><option>USD</option><option>CAD</option></select></label>
            {!w.has_key && <label htmlFor="sp">Price per share<input id="sp" type="text" inputMode="decimal" placeholder="optional" value={f.price} onChange={(ev) => setF({ ...f, price: ev.target.value })} /></label>}
          </div>
          <p className="muted small" style={{ margin: 0 }}>Toronto tickers end in .TRT (TSX) or .TRV (Venture). US holdings are converted to CAD at the day's rate. Only the ticker is ever sent to the price service, never how many shares you hold.</p>
          <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? "Adding…" : "Add stock"}</button><button className="btn ghost" type="button" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {(add === "home" || add === "other") && (
        <form className="form" onSubmit={(ev) => { ev.preventDefault(); act(async () => { await s.call("/api/money/assets", json("POST", { name: f.name, kind: f.kind, value: f.value, owing: f.owing })); setNote("Added."); reset(); }); }}>
          <div className="fields">
            <label htmlFor="an">Name<input id="an" type="text" required value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} /></label>
            {add === "other" && <label htmlFor="ak">Kind<select id="ak" value={f.kind} onChange={(ev) => setF({ ...f, kind: ev.target.value })}>{["Cash", "Investments", "Business", "Vehicle", "Other"].map((k) => <option key={k}>{k}</option>)}</select></label>}
            <label htmlFor="av">{add === "home" ? "What it's worth now" : "Worth"}<input id="av" type="text" inputMode="decimal" required value={f.value} onChange={(ev) => setF({ ...f, value: ev.target.value })} /></label>
            <label htmlFor="ao">{add === "home" ? "Still owing on the mortgage" : "Owing against it (optional)"}<input id="ao" type="text" inputMode="decimal" placeholder="0" value={f.owing} onChange={(ev) => setF({ ...f, owing: ev.target.value })} /></label>
          </div>
          {add === "home" && <p className="muted small" style={{ margin: 0 }}>Your equity is the worth minus what's owing. Neither number updates by itself, so use Update when the mortgage balance or the value changes.</p>}
          <div className="row"><button className="btn" type="submit" disabled={busy}>Add</button><button className="btn ghost" type="button" onClick={reset}>Cancel</button></div>
        </form>
      )}
      {add === "key" && (
        <form className="form" onSubmit={(ev) => { ev.preventDefault(); act(async () => { await s.call("/api/money/assets/quote-key", json("PUT", { key: f.key })); setNote(f.key ? "Key saved. Tap Refresh prices." : "Key removed."); reset(); }); }}>
          <label htmlFor="qk" className="eyebrow">Alpha Vantage API key</label>
          <input id="qk" type="password" autoComplete="off" placeholder={w.has_key ? "saved · paste a new one to replace it" : "paste your key"} value={f.key} onChange={(ev) => setF({ ...f, key: ev.target.value })} />
          <p className="muted small" style={{ margin: 0 }}>Stock prices come from Alpha Vantage, which gives a free key at alphavantage.co/support/#api-key. The free key allows about 25 lookups a day, so prices are end-of-day and refreshed once daily. Without a key you can still add stocks and type prices in.</p>
          <div className="row"><button className="btn" type="submit">Save</button><button className="btn ghost" type="button" onClick={reset}>Cancel</button></div>
        </form>
      )}
    </div>
  );
}

const exact = (n: number) => `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
interface Pdf { account?: string; name: string; via: string; can_use_model: boolean; rows: Array<{ day: string; description: string; amount: number }>; skipped: number; layout: string; note?: string; file: File }

function Feed({ s, onDone, onError }: { s: Session; onDone: (message: string) => void; onError: (m: string) => void }) {
  const [account, setAccount] = useState("");
  const [flip, setFlip] = useState(false);
  const [hand, setHand] = useState(false);
  const [form, setForm] = useState({ amount: "", description: "", day: "", kind: "out" });
  const [receipt, setReceipt] = useState<File | null>(null);

  const [pdfs, setPdfs] = useState<Pdf[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const readPdf = async (file: File, model = false) => {
    setReading(file.name);
    const data = new FormData();
    data.set("file", file); if (model) data.set("model", "1");
    try { const r = await s.call<Omit<Pdf, "file">>("/api/money/read-pdf", { method: "POST", body: data }); setPdfs((list) => [...list.filter((p) => p.name !== r.name), { ...r, file }]); }
    catch (e) { onError(`${file.name}: ${(e as Error).message}`); }
    finally { setReading(null); }
  };
  const importAll = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) { if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") await readPdf(f); else await importFile(f); }
  };
  const savePdf = async (p: Pdf) => {
    try {
      const r = await s.call<{ added: number; already_there: number }>("/api/money/import-rows", json("POST", { rows: p.rows, account: p.account ?? account }));
      setPdfs((list) => list.filter((x) => x !== p));
      onDone(`${p.name}: added ${r.added} transaction${r.added === 1 ? "" : "s"}.${r.already_there ? ` ${r.already_there} were already here.` : ""}`);
    } catch (e) { onError((e as Error).message); }
  };
  const change = (p: Pdf, rows: Pdf["rows"]) => setPdfs((list) => list.map((x) => (x === p ? { ...p, rows } : x)));

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const data = new FormData();
    data.set("file", file); data.set("account", account); if (flip) data.set("flip", "1");
    try {
      const r = await s.call<{ added: number; already_there: number; unreadable: number; from: string; to: string }>("/api/money/import", { method: "POST", body: data });
      onDone(`Added ${r.added} transaction${r.added === 1 ? "" : "s"} from ${r.from} to ${r.to}.${r.already_there ? ` ${r.already_there} were already here.` : ""}${r.unreadable ? ` ${r.unreadable} line${r.unreadable === 1 ? "" : "s"} couldn't be read.` : ""}`);
    } catch (e) { onError((e as Error).message); }
  };
  const addByHand = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = new FormData();
    Object.entries(form).forEach(([k, v]) => data.set(k, v));
    if (receipt) data.set("file", receipt);
    try {
      await s.call("/api/money/tx", { method: "POST", body: data });
      setForm({ amount: "", description: "", day: "", kind: "out" }); setReceipt(null); setHand(false);
      onDone("Added.");
    } catch (err) { onError((err as Error).message); }
  };

  return (
    <section className="card pad stack feed">
      <span className="eyebrow">Feed it</span>
      <div className="fields">
        <label htmlFor="acct">Which account is this file from?<input id="acct" type="text" placeholder="e.g. Chequing, Visa" value={account} onChange={(e) => setAccount(e.target.value)} /></label>
      </div>
      <label className="check" htmlFor="flip"><input id="flip" type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /><span>It's a credit card export where purchases show as positive numbers</span></label>
      <div className="row">
        <label className="btn as-link upload">{reading ? `Reading ${reading}…` : "Import statements (PDF or CSV)"}<input className="sr" type="file" multiple accept=".csv,.pdf,text/csv,text/plain,application/pdf" onChange={(e) => { const f = e.target.files; importAll(f).finally(() => { e.target.value = ""; }); }} /></label>
        <button className="btn" onClick={() => setHand(!hand)}>{hand ? "Cancel" : "Add one by hand, with a receipt"}</button>
      </div>
      {pdfs.map((p) => {
        const out = p.rows.filter((r) => r.amount < 0).reduce((a, r) => a - r.amount, 0), inn = p.rows.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0);
        const days = p.rows.map((r) => r.day).sort();
        return (
          <div key={p.name} className="pdf-preview stack">
            <span className="eyebrow electro">{p.name} · read {p.via === "model" ? "by the Money model" : "on your Umbrel"}</span>
            {p.rows.length === 0 ? <p className="accent" style={{ margin: 0 }}>{p.note ?? "No transactions found."}</p> : (
              <>
                <span>{p.rows.length} transaction{p.rows.length === 1 ? "" : "s"} · {days[0]} to {days[days.length - 1]} · {exact(out)} out · {exact(inn)} in{p.skipped ? ` · ${p.skipped} line${p.skipped === 1 ? "" : "s"} skipped` : ""}</span>
                <span className="muted small">Check a few against the statement. Money out should be negative. Nothing is saved until you tap Import.</span>
                <div className="pdf-rows">
                  <table><tbody>
                    {p.rows.map((r, i) => (
                      <tr key={i}><td className="muted">{r.day}</td><td>{r.description}</td><td className={r.amount > 0 ? "num electro" : "num"}>{r.amount > 0 ? "+" : "−"}{exact(Math.abs(r.amount))}</td>
                        <td><button className="btn ghost" aria-label={`Leave out ${r.description}`} onClick={() => change(p, p.rows.filter((_, j) => j !== i))}>✕</button></td></tr>
                    ))}
                  </tbody></table>
                </div>
              </>
            )}
            <div className="row">
              {p.rows.length > 0 && <input className="plain-input" type="text" aria-label={`Account for ${p.name}`} placeholder="Account, e.g. Visa" value={p.account ?? account} onChange={(e) => setPdfs((list) => list.map((x) => (x === p ? { ...p, account: e.target.value } : x)))} />}
              {p.rows.length > 0 && <button className="btn" onClick={() => savePdf(p)}>Import {p.rows.length}</button>}
              {p.rows.length > 0 && <button className="btn ghost" onClick={() => change(p, p.rows.map((r) => ({ ...r, amount: -r.amount })))}>In and out are backwards: flip them</button>}
              {p.can_use_model && <button className="btn ghost" disabled={reading !== null} onClick={() => readPdf(p.file, true)}>Looks wrong: have the Money model read it</button>}
              <button className="btn ghost" onClick={() => setPdfs((list) => list.filter((x) => x !== p))}>Discard</button>
            </div>
            {p.can_use_model && <span className="muted small">The model option sends this statement's full text to your Money model. The default reading never leaves the Umbrel.</span>}
          </div>
        );
      })}
      {hand && (
        <form className="form" onSubmit={addByHand}>
          <div className="fields">
            <label htmlFor="ha">Amount<input id="ha" type="text" inputMode="decimal" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            <label htmlFor="hd">What for<input id="hd" type="text" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <label htmlFor="hw">Day<input id="hw" type="date" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} /></label>
            <label htmlFor="hk">Direction<select id="hk" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="out">Money out</option><option value="in">Money in</option></select></label>
          </div>
          <label className="btn as-link upload">{receipt ? `Receipt: ${receipt.name}` : "Attach a receipt photo or screenshot"}<input className="sr" type="file" accept="image/*,application/pdf" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} /></label>
          <div className="row"><button className="btn" type="submit">Add</button></div>
        </form>
      )}
      <p className="muted small">Statements are read on your Umbrel. Receipts are kept with the entry; amounts aren't read from the image yet, so type them.</p>
    </section>
  );
}

/* ---------- Bitcoin wallets ---------- */
interface Wallet { id: number; label: string; type_name: string; key_end: string; synced_at: string | null; sats: number; transactions: number; pending: number; cad: number | null }
interface Btc { sends_are_payments: boolean; wallets: Wallet[]; price: number | null; total_sats: number; total_cad: number | null; api: string; price_api: string; api_is_public: boolean; types: Record<string, string> }
const btcOf = (sats: number) => `${(sats / 1e8).toFixed(8)} BTC`;
const cad = (n: number | null) => (n === null ? "price unavailable" : `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function Bitcoin({ s, onChanged, onError }: { s: Session; onChanged: () => void; onError: (m: string) => void }) {
  const [v, setV] = useState<Btc | null>(null);
  const [open, setOpen] = useState<null | "add" | "server">(null);
  const [f, setF] = useState({ label: "", key: "", type: "" });
  const [srv, setSrv] = useState({ api: "", price_api: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [gone, setGone] = useState<number | null>(null);
  const load = useCallback(() => s.call<Btc>("/api/money/btc").then((b) => { setV(b); setSrv({ api: b.api, price_api: b.price_api }); }).catch((e) => onError(e.message)), [s, onError]);
  useEffect(() => { load(); }, [load]);
  if (!v) return null;
  const run = async (what: string, fn: () => Promise<unknown>) => { setBusy(what); setNote(null); try { await fn(); await load(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); } };
  const sync = () => run("sync", async () => { const r = await s.call<{ transactions: number; transfers: number }>("/api/money/btc/sync", { method: "POST" }); setNote(`Up to date. ${r.transactions} new transaction${r.transactions === 1 ? "" : "s"}${r.transfers ? `, ${r.transfers} move${r.transfers === 1 ? "" : "s"} between your own wallets` : ""}.`); onChanged(); });
  return (
    <section className="card pad stack">
      <div className="row"><span className="eyebrow grow">Bitcoin{v.price ? ` · 1 BTC = ${cad(v.price)} CAD` : ""}</span>{v.wallets.length > 0 && <button className="btn" disabled={busy !== null} onClick={sync}>{busy === "sync" ? "Checking the chain…" : "Sync now"}</button>}</div>
      {v.wallets.length === 0 ? <p className="muted" style={{ margin: 0 }}>Add a wallet's public key (xpub, ypub, zpub) or multisig descriptor to track its balance and count what you're paid in bitcoin. It's watch-only: nothing here can spend.</p> : (
        <>
          <span className="next-title" style={{ fontSize: 32 }}>{cad(v.total_cad)}</span>
          <span className="muted small">{btcOf(v.total_sats)} across {v.wallets.length} wallet{v.wallets.length === 1 ? "" : "s"} · valued at today's price</span>
          <ul className="list">
            {v.wallets.map((w) => (
              <li key={w.id}>
                <span className="grow">{w.label}<span className="muted small block">{btcOf(w.sats)} · {w.transactions} transaction{w.transactions === 1 ? "" : "s"}{w.pending ? ` · ${w.pending} unconfirmed` : ""} · {w.type_name} · key ending {w.key_end}{w.synced_at ? "" : " · not synced yet"}</span></span>
                <span>{cad(w.cad)}</span>
                {gone === w.id
                  ? <><button className="btn" onClick={() => run("rm", async () => { await s.call(`/api/money/btc/wallets/${w.id}`, { method: "DELETE" }); setGone(null); onChanged(); })}>Remove it and its transactions</button><button className="btn ghost" onClick={() => setGone(null)}>Keep</button></>
                  : <button className="btn ghost" aria-label={`Remove ${w.label}`} onClick={() => setGone(w.id)}>✕</button>}
              </li>
            ))}
          </ul>
        </>
      )}
      {v.wallets.length > 0 && (
        <label className="check" htmlFor="sap"><input id="sap" type="checkbox" checked={v.sends_are_payments} onChange={(e) => run("rule", async () => { await s.call("/api/money/btc/config", json("PUT", { sends_are_payments: e.target.checked })); onChanged(); })} /><span>Bitcoin I send is paying off cards or bills, not new spending. (Moves between my own wallets are never counted either way.)</span></label>
      )}
      {note && <p className="small electro" role="status" style={{ margin: 0, overflowWrap: "anywhere" }}>{note}</p>}
      {!v.api && <p className="accent small" style={{ margin: 0 }}>Set the address server before syncing.</p>}
      {v.api_is_public && <p className="accent small" style={{ margin: 0 }}>The address server is a public one, so its operator can see which addresses are yours. Your own node's mempool app avoids that.</p>}
      <div className="row">
        <button className="btn" onClick={() => setOpen(open === "add" ? null : "add")}>{open === "add" ? "Cancel" : "Add a wallet"}</button>
        <button className="btn ghost" onClick={() => setOpen(open === "server" ? null : "server")}>Address server</button>
      </div>
      {open === "add" && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); run("add", async () => { const r = await s.call<{ first_address: string; signers?: string }>("/api/money/btc/wallets", json("POST", { ...f, type: f.type || undefined })); setF({ label: "", key: "", type: "" }); setOpen(null); setNote(`Wallet added${r.signers ? ` (${r.signers} multisig)` : ""}. Its first receive address is ${r.first_address}. If that matches your wallet, tap Sync now.`); }); }}>
          <div className="fields">
            <label htmlFor="bl">Name this account<input id="bl" type="text" required placeholder="Spending, Taxes, Savings…" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
            <label htmlFor="bt">Address type<select id="bt" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">Work it out for me</option>{Object.entries(v.types).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
          </div>
          <label htmlFor="bk" className="eyebrow">Public key (xpub, ypub, zpub) or output descriptor, including multisig</label>
          <textarea id="bk" className="plain" required autoCapitalize="off" autoCorrect="off" spellCheck={false} value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
          <p className="muted small" style={{ margin: 0 }}>Public keys only. Never paste a seed phrase or a private key anywhere. For multisig, paste the output descriptor from your coordinator, e.g. wsh(sortedmulti(2,[…]xpub…/&lt;0;1&gt;/*,…)). The address type is read from the descriptor.</p>
          <div className="row"><button className="btn" type="submit" disabled={busy !== null}>{busy === "add" ? "Adding…" : "Add wallet"}</button></div>
        </form>
      )}
      {open === "server" && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); run("srv", async () => { await s.call("/api/money/btc/config", json("PUT", { ...srv, test: true })); setNote("Server saved and reachable."); setOpen(null); }); }}>
          <div className="fields">
            <label htmlFor="ba">Address server (mempool or Esplora API)<input id="ba" type="text" autoCapitalize="off" placeholder="http://mempool_web_1:3006/api" value={srv.api} onChange={(e) => setSrv({ ...srv, api: e.target.value })} /></label>
            <label htmlFor="bp">Price source (optional)<input id="bp" type="text" autoCapitalize="off" placeholder="https://mempool.space/api" value={srv.price_api} onChange={(e) => setSrv({ ...srv, price_api: e.target.value })} /></label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>Your addresses are only ever sent to the address server, so point it at your own node. The price source is asked for CAD prices and nothing else: no addresses, no amounts.</p>
          <div className="row"><button className="btn" type="submit" disabled={busy !== null}>{busy === "srv" ? "Checking…" : "Save and test"}</button></div>
        </form>
      )}
    </section>
  );
}
