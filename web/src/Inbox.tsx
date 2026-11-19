import { useCallback, useEffect, useState } from "react";
import { call, json } from "./api";
import { MicButton, ScreenHead, useDictation } from "./ui";

interface Mail { id: number; from_name: string; from_addr: string; subject: string; date: string; summary: string | null; bucket: string; suggest_name: string | null; suggest_email: string | null; status: string; handled_how: string | null }
interface Person { name: string; email: string }
interface Box { connected: boolean; user: string; synced: string | null; has_model: boolean; auto: boolean; you: Mail[]; unsure: Mail[]; handoff: Mail[]; fyi: Mail[]; handled: Mail[]; delegates: Person[] }
type Props = { onBack: () => void; onError: (m: string) => void; stt?: boolean };

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
};

export function Inbox({ onBack, onError, stt }: Props) {
  const [box, setBox] = useState<Box | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [showFyi, setShowFyi] = useState(false);

  const load = useCallback(() => call<Box>("/api/inbox").then(setBox).catch((e) => onError(e.message)), [onError]);
  const check = useCallback(async () => {
    setBusy(true); setNote(null);
    try {
      const r = await call<{ added: number; auto: number }>("/api/inbox/sync", { method: "POST" });
      setNote(r.added ? `${r.added} new${r.auto ? `, ${r.auto} handed off automatically` : ""}.` : "Nothing new.");
      await load();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }, [load, onError]);
  useEffect(() => { load().then(() => call<Box>("/api/inbox").then((b) => { if (b.connected && (!b.synced || Date.now() - new Date(b.synced).getTime() > 5 * 60_000)) check(); }).catch(() => {})); }, [load, check]);

  if (!box) return <p className="muted">Loading…</p>;
  const done = async (text: string) => { setOpen(null); setNote(text); await load(); };
  const section = (title: string, list: Mail[], empty: string, hot?: boolean) => (
    <section className="stack">
      <span className={hot ? "eyebrow accent" : "eyebrow"}>{title} · {list.length}</span>
      {list.length === 0 && <p className="muted small">{empty}</p>}
      {list.map((m) => <Row key={m.id} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} people={box.delegates} stt={Boolean(stt)} hasModel={box.has_model} onError={onError} onDone={done} />)}
    </section>
  );

  return (
    <div className="stack">
      <ScreenHead title="Inbox" onBack={onBack} right={box.connected ? <button className="btn" onClick={check} disabled={busy}>{busy ? "Checking…" : "Check now"}</button> : undefined} />
      {!box.connected ? (
        <section className="card pad stack">
          <span className="eyebrow accent">Not connected yet</span>
          <p style={{ margin: 0 }}>Add your Gmail address and a Gmail app password in Settings. An app password is a 16-letter code Google gives you under Security › 2-Step Verification › App passwords. It only works for mail and you can revoke it any time.</p>
          <p className="muted small" style={{ margin: 0 }}>Nothing in Gmail is changed: mail isn't marked read, moved or deleted. Replies and hand-offs only go out when you tap Send.</p>
        </section>
      ) : (
        <>
          <p className="muted small" style={{ margin: 0 }}>{box.user} · checked {ago(box.synced)}{box.auto ? " · automatic hand-off is on" : ""}{!box.has_model ? " · no model set, so sorting is basic" : ""}</p>
          {note && <p className="small electro" role="status" style={{ margin: 0 }}>{note}</p>}
          {section("For you", box.you, "Nothing waiting on you.", true)}
          {section("Hand off", box.handoff, "Nothing to hand off. Once you've handed a sender's mail to someone, the next one shows here ready to go.")}
          {section("Couldn't place", box.unsure, "Everything found a home.")}
          <section className="stack">
            <button className="linkish" aria-expanded={showFyi} onClick={() => setShowFyi(!showFyi)}>Nothing to do · {box.fyi.length} {showFyi ? "▾" : "▸"}</button>
            {showFyi && box.fyi.map((m) => <Row key={m.id} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} people={box.delegates} stt={Boolean(stt)} hasModel={box.has_model} onError={onError} onDone={done} />)}
            {showFyi && box.fyi.length > 1 && <div className="row"><button className="btn ghost" onClick={async () => { await Promise.all(box.fyi.map((m) => call(`/api/inbox/${m.id}`, json("PATCH", { done: true })))).catch((e) => onError(e.message)); done("Cleared."); }}>Clear all {box.fyi.length}</button></div>}
          </section>
          <section className="card pad stack">
            <div className="row"><span className="eyebrow grow">Dealt with in the last day · {box.handled.length}</span><button className="btn ghost" onClick={() => call<{ text: string }>("/api/inbox-summary").then((r) => setSummary(r.text)).catch((e) => onError(e.message))}>Hand-off summary</button></div>
            {summary && <p style={{ margin: 0 }}>{summary}</p>}
            <ul className="list">{box.handled.map((m) => <li key={m.id}><span className="grow">{m.subject}<span className="muted small block">{m.from_name} · {m.handled_how}</span></span><button className="btn ghost" onClick={() => call(`/api/inbox/${m.id}`, json("PATCH", { done: false })).then(load).catch((e) => onError(e.message))}>Put back</button></li>)}</ul>
          </section>
        </>
      )}
    </div>
  );
}

function Row({ m, open, onToggle, people, stt, hasModel, onError, onDone }: { m: Mail; open: boolean; onToggle: () => void; people: Person[]; stt: boolean; hasModel: boolean; onError: (m: string) => void; onDone: (note: string) => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [mode, setMode] = useState<null | "reply" | "handoff" | "task" | "ask">(null);
  const [todo, setTodo] = useState("");
  const dt = useDictation(stt, (t) => setTodo((x) => (x ? x + " " : "") + t), onError);
  const [say, setSay] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [cc, setCc] = useState("");
  const [fwd, setFwd] = useState("");
  const [to, setTo] = useState<Person>({ name: m.suggest_name ?? "", email: m.suggest_email ?? "" });
  const [msg, setMsg] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const d = useDictation(stt, (t) => setSay((x) => (x ? x + " " : "") + t), onError);

  useEffect(() => { if (open && body === null) call<{ body: string }>(`/api/inbox/${m.id}`).then((r) => setBody(r.body)).catch((e) => onError(e.message)); }, [open, body, m.id, onError]);
  const run = async (fn: () => Promise<unknown>, after?: string) => { setBusy(true); try { await fn(); if (after) onDone(after); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } };
  const makeDraft = () => run(async () => { const r = await call<{ text: string; note?: string }>(`/api/inbox/${m.id}/draft`, json("POST", { say })); setDraft(r.text); if (r.note) onError(r.note); });
  const hand = (p: Person, note = "") => run(() => call(`/api/inbox/${m.id}/handoff`, json("POST", { ...p, note, remember })), `Handed to ${p.name}.`);

  return (
    <div className={open ? "card mail open" : "card mail"}>
      <button className="mail-head" aria-expanded={open} onClick={onToggle}>
        <span className="grow"><strong>{m.from_name}</strong> <span className="muted small">{ago(m.date)}</span><span className="block">{m.subject}</span>{m.summary && <span className="muted small block">{m.summary}</span>}</span>
        {m.suggest_name && <span className="status ok">→ {m.suggest_name}</span>}
      </button>
      {!open && m.suggest_name && m.suggest_email && <div className="row mail-quick"><button className="btn" disabled={busy} onClick={() => hand({ name: m.suggest_name!, email: m.suggest_email! })}>Send to {m.suggest_name}</button></div>}
      {open && (
        <div className="pad stack">
          <span className="muted small">{m.from_addr}</span>
          <p className="handed">{body ?? "Loading…"}</p>
          {mode === null && (
            <div className="row">
              <button className="btn" onClick={() => setMode("reply")}>Reply</button>
              <button className="btn" onClick={() => setMode("handoff")}>Hand off</button>
              <button className="btn" onClick={() => { setTodo(""); setMode("task"); }}>Task for me</button>
              <button className="btn" onClick={() => { setTodo(""); setMode("ask"); }}>Have Hermes do it</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(() => call(`/api/inbox/${m.id}`, json("PATCH", { done: true })), "Cleared.")}>Clear</button>
            </div>
          )}
          {mode === "reply" && (
            <div className="form">
              {draft === null ? (
                <>
                  <label htmlFor={`say${m.id}`} className="eyebrow">What do you want to tell them?</label>
                  <div className="row" style={{ alignItems: "flex-start" }}>
                    <textarea id={`say${m.id}`} className="plain grow" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : hasModel ? "Say the gist. It writes the email for you to check." : "Type or say the reply."} value={say} onChange={(e) => setSay(e.target.value)} />
                    <MicButton d={d} small />
                  </div>
                  <div className="row"><button className="btn" disabled={busy || !say.trim()} onClick={makeDraft}>{busy ? "Writing…" : "Write the reply"}</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
                </>
              ) : (
                <>
                  <label htmlFor={`dr${m.id}`} className="eyebrow">Reply to {m.from_name} · check it, change it</label>
                  <textarea id={`dr${m.id}`} className="plain tall" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <div className="fields">
                    <label htmlFor={`cc${m.id}`}>CC<input id={`cc${m.id}`} type="text" inputMode="email" autoCapitalize="off" placeholder="optional" value={cc} onChange={(e) => setCc(e.target.value)} /></label>
                    <label htmlFor={`fw${m.id}`}>Also forward the thread to<input id={`fw${m.id}`} type="text" inputMode="email" autoCapitalize="off" placeholder="optional" value={fwd} onChange={(e) => setFwd(e.target.value)} /></label>
                  </div>
                  <div className="row">
                    <button className="btn" disabled={busy || !draft.trim()} onClick={() => run(() => call(`/api/inbox/${m.id}/send`, json("POST", { text: draft, cc, forward_to: fwd })), `Reply sent to ${m.from_name}.`)}>{busy ? "Sending…" : "Send"}</button>
                    <button className="btn ghost" onClick={() => setDraft(null)}>Start over</button>
                    <button className="btn ghost" onClick={() => { setMode(null); setDraft(null); }}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
          {(mode === "task" || mode === "ask") && (
            <div className="form">
              <label htmlFor={`td${m.id}`} className="eyebrow">{mode === "task" ? "What do you need to do about this?" : "What should Hermes do with this email?"}</label>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <textarea id={`td${m.id}`} className="plain grow" placeholder={dt.recording ? `Listening… ${dt.clock}` : dt.busy ? "Writing it down…" : mode === "task" ? "e.g. Sign the contract by Friday, important" : "e.g. Make a note of the affiliate details for a later tutorial"} value={todo} onChange={(e) => setTodo(e.target.value)} />
                <MicButton d={dt} small />
              </div>
              <p className="muted small" style={{ margin: 0 }}>{mode === "task" ? "It goes on your deck with a note saying which email it's about. The email stays here." : "Hermes gets your instruction and this email. Its answer shows at the top of your deck."}</p>
              <div className="row">
                {mode === "task"
                  ? <button className="btn" disabled={busy || !todo.trim()} onClick={() => run(() => call(`/api/inbox/${m.id}/task`, json("POST", { text: todo })), "Task added to your deck.")}>Add task</button>
                  : <button className="btn" disabled={busy || !todo.trim()} onClick={() => run(() => call("/api/asks", json("POST", { text: todo, mail_id: m.id })), "Handed to Hermes. The answer will be on your deck.")}>Hand to Hermes</button>}
                <button className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
              </div>
            </div>
          )}
          {mode === "handoff" && (
            <div className="form">
              {people.length > 0 && <div className="row">{people.map((p) => <button key={p.email} type="button" className="status" aria-pressed={to.email === p.email} style={to.email === p.email ? { background: "#fff", color: "#0d101c" } : undefined} onClick={() => setTo(p)}>{p.name}</button>)}</div>}
              <div className="fields">
                <label htmlFor={`hn${m.id}`}>Who<input id={`hn${m.id}`} type="text" value={to.name} onChange={(e) => setTo({ ...to, name: e.target.value })} /></label>
                <label htmlFor={`he${m.id}`}>Their email<input id={`he${m.id}`} type="email" autoCapitalize="off" value={to.email} onChange={(e) => setTo({ ...to, email: e.target.value })} /></label>
              </div>
              <label htmlFor={`hm${m.id}`} className="eyebrow">Note to them (optional)</label>
              <textarea id={`hm${m.id}`} className="plain" value={msg} onChange={(e) => setMsg(e.target.value)} />
              <label className="check" htmlFor={`hr${m.id}`}><input id={`hr${m.id}`} type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>Remember that mail from {m.from_addr} goes to them</span></label>
              <div className="row"><button className="btn" disabled={busy || !to.name.trim() || !to.email.trim()} onClick={() => hand(to, msg)}>{busy ? "Sending…" : "Forward and hand off"}</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
