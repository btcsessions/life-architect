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
interface Tx { id: number; day: string; description: string; merchant: string; amount: number; category: string; account: string | null; file_id: number | null }
interface Asset { id: number; name: string; kind: string; value: number; updated_at: string }
type Props = { onBack: () => void; onError: (m: string) => void };

const COLORS = ["#f7931a", "#7ed3f2", "#7ef2a8", "#3fa8d4", "#ffb35c", "#b8bdcc", "#c46f0a", "#8a90a3"];
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
            <Dig title="Every transaction" total={`${sum.count} this month`} open={dig === "tx"} onToggle={() => setDig(dig === "tx" ? null : "tx")}>
              <Transactions s={s} month={sum.month} category={cat} onChanged={load} onError={onError} />
            </Dig>
          </section>
        </>
      )}

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
  const [data, setData] = useState<{ tx: Tx[]; categories: string[] } | null>(null);
  const load = useCallback(() => s.call<{ tx: Tx[]; categories: string[] }>(`/api/money/tx?month=${month}${category ? `&category=${encodeURIComponent(category)}` : ""}`).then(setData).catch((e) => onError(e.message)), [s, month, category, onError]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="muted">Loading…</p>;
  const resort = async (t: Tx, cat: string) => {
    const always = window.confirm(`Put everything from "${t.merchant}" in ${cat} from now on?\n\nOK: always. Cancel: just this one.`);
    try { await s.call(`/api/money/tx/${t.id}`, json("PATCH", { category: cat, always })); await load(); onChanged(); } catch (e) { onError((e as Error).message); }
  };
  return (
    <>
      {category && <p className="muted small">Showing {category} only. Close the category above to see everything.</p>}
      <ul className="list">
        {data.tx.map((t) => (
          <li key={t.id}>
            <span className="grow">{t.merchant}<span className="muted small block">{t.day} · {t.description}{t.account ? ` · ${t.account}` : ""}{t.file_id ? <> · <a href={`/api/money/files/${t.file_id}`} target="_blank" rel="noreferrer">receipt</a></> : null}</span></span>
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

function Assets({ s, onError }: { s: Session; onError: (m: string) => void }) {
  const [list, setList] = useState<Asset[] | null>(null);
  const [form, setForm] = useState({ name: "", kind: "Bitcoin", value: "" });
  const load = useCallback(() => s.call<{ assets: Asset[] }>("/api/money/assets").then((r) => setList(r.assets)).catch((e) => onError(e.message)), [s, onError]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      {list.length === 0 ? <p className="muted small">Add what you hold and update the values when you like. Nothing here is fetched or connected to anything.</p> : (
        <>
          <ul className="list">
            {list.map((a) => (
              <li key={a.id}>
                <span className="grow">{a.name}<span className="muted small block">{a.kind} · updated {a.updated_at}</span></span>
                <span>{money(a.value)}</span>
                <button className="btn ghost" onClick={() => { const v = window.prompt(`New value for ${a.name}`, String(a.value)); if (v) act(() => s.call(`/api/money/assets/${a.id}`, json("PATCH", { value: v }))); }}>Update</button>
                <button className="btn ghost" aria-label={`Remove ${a.name}`} onClick={() => act(() => s.call(`/api/money/assets/${a.id}`, { method: "DELETE" }))}>✕</button>
              </li>
            ))}
          </ul>
          <p className="right"><strong>{money(list.reduce((t, a) => t + a.value, 0))}</strong> <span className="muted small">in total</span></p>
        </>
      )}
      <form className="form" onSubmit={(e) => { e.preventDefault(); act(async () => { await s.call("/api/money/assets", json("POST", form)); setForm({ ...form, name: "", value: "" }); }); }}>
        <div className="fields">
          <label htmlFor="an">Name<input id="an" type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label htmlFor="ak">Kind<select id="ak" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{["Bitcoin", "Cash", "Investments", "Business", "Property", "Other"].map((k) => <option key={k}>{k}</option>)}</select></label>
          <label htmlFor="av">Worth<input id="av" type="text" inputMode="decimal" required value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></label>
        </div>
        <div className="row"><button className="btn" type="submit">Add</button></div>
      </form>
    </div>
  );
}

function Feed({ s, onDone, onError }: { s: Session; onDone: (message: string) => void; onError: (m: string) => void }) {
  const [account, setAccount] = useState("");
  const [flip, setFlip] = useState(false);
  const [hand, setHand] = useState(false);
  const [form, setForm] = useState({ amount: "", description: "", day: "", kind: "out" });
  const [receipt, setReceipt] = useState<File | null>(null);

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
        <label className="btn as-link upload">Import a statement (CSV)<input className="sr" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <button className="btn" onClick={() => setHand(!hand)}>{hand ? "Cancel" : "Add one by hand, with a receipt"}</button>
      </div>
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
