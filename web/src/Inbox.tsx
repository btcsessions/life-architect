import { useCallback, useEffect, useRef, useState } from "react";
import { call, json } from "./api";
import { MicButton, ScreenHead, useDictation } from "./ui";

// The Inbox shows only what Hermes's email runs flagged as needing Ben. Hermes does the sorting; this is where he acts.
interface Item {
  id: number; key: string; kind: "you" | "unsure" | "watch"; category: string | null; source: string; from_name: string | null; from_addr: string | null;
  subject: string; summary: string | null; need: string | null; due: string | null; has_draft: boolean; suggest_name: string | null; suggest_email: string | null;
  watch: string | null; status: "new" | "seen" | "done"; first_at: string; updated_at: string; done_how: string | null; done_at: string | null; gmail: string | null; can_open: boolean;
}
interface Person { name: string; email: string }
interface Handled { forwarded: Array<{ to: string | null; from: string | null; subject: string | null }>; cold: Array<{ from: string | null; subject: string | null }>; suspicious: Array<{ from: string | null; subject: string | null; why: string | null }>; trashed: number; archived: number; money: number; note: string | null }
interface Box { connected: boolean; user: string; has_model: boolean; you: Item[]; unsure: Item[]; watch: Item[]; handled: Item[]; last_run: { ts: string; items: number; fresh: number; handled: Handled | null } | null; last_urgent: string | null; delegates: Person[] }
interface Full extends Item { draft: string | null; mail_id: number | null; body: string | null }
type Props = { onBack: () => void; onError: (m: string) => void; stt?: boolean };

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
};
const due = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
const LABEL: Record<string, string> = { hrf: "HRF", travel: "Travel", direct: "Asked you", security: "Security", watch: "Watch" };

export function Inbox({ onBack, onError, stt }: Props) {
  const [box, setBox] = useState<Box | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const seen = useRef(false);

  const load = useCallback(() => call<Box>("/api/inbox").then(setBox).catch((e) => onError(e.message)), [onError]);
  // Load first (so this visit still shows what's new), then clear the badge.
  useEffect(() => { load().then(() => { if (!seen.current) { seen.current = true; call("/api/inbox/seen", { method: "POST" }).catch(() => {}); } }); }, [load]);

  if (!box) return <p className="muted">Loading…</p>;
  const done = async (text: string) => { setOpen(null); setNote(text); await load(); };
  const rows = (list: Item[]) => list.map((i) => <Row key={i.id} item={i} open={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)} people={box.delegates} connected={box.connected} stt={Boolean(stt)} hasModel={box.has_model} onError={onError} onDone={done} />);
  const h = box.last_run?.handled;
  const total = box.you.length + box.unsure.length + box.watch.length;

  return (
    <div className="stack">
      <ScreenHead title="Inbox" onBack={onBack} right={<a className="btn ghost" href="https://mail.google.com/" target="_blank" rel="noreferrer">Gmail</a>} />
      <p className="muted small" style={{ margin: 0 }}>
        {box.last_run ? `Hermes last sorted ${ago(box.last_run.ts)}` : "Hermes hasn't sent a sort yet"}
        {box.last_urgent ? ` · urgent check ${ago(box.last_urgent)}` : ""}
      </p>
      {!box.connected && <p className="small accent" style={{ margin: 0 }}>Add your Gmail login in Settings to open, reply to and hand off these emails here.</p>}
      {note && <p className="small electro" role="status" style={{ margin: 0 }}>{note}</p>}

      <section className="stack">
        <span className="eyebrow accent">For you · {box.you.length}</span>
        {box.you.length === 0 && <p className="muted small">{total ? "Nothing needs a reply or decision from you." : "Nothing needs you. Hermes is handling the rest."}</p>}
        {rows(box.you)}
      </section>
      {box.unsure.length > 0 && <section className="stack"><span className="eyebrow">Who handles this? · {box.unsure.length}</span>{rows(box.unsure)}</section>}
      {box.watch.length > 0 && <section className="stack"><span className="eyebrow">Watching · {box.watch.length}</span>{rows(box.watch)}</section>}

      <section className="card pad stack">
        <button className="linkish" aria-expanded={showDigest} onClick={() => setShowDigest(!showDigest)} style={{ textAlign: "left" }}>
          Handled for you{h ? ` · ${[h.forwarded.length ? `${h.forwarded.length} forwarded` : "", h.trashed ? `${h.trashed} trashed` : "", h.archived ? `${h.archived} archived` : "", h.money ? `${h.money} to Caleb` : ""].filter(Boolean).join(", ") || "nothing"}` : ""} {showDigest ? "▾" : "▸"}
        </button>
        {showDigest && (
          <div className="stack">
            {!h && <p className="muted small" style={{ margin: 0 }}>Nothing from Hermes's sort yet.</p>}
            {h?.note && <p style={{ margin: 0 }}>{h.note}</p>}
            {h && h.forwarded.length > 0 && <Digest title="Forwarded" lines={h.forwarded.map((f) => `${f.subject ?? "(no subject)"}${f.from ? ` · ${f.from}` : ""}${f.to ? ` → ${f.to}` : ""}`)} />}
            {h && h.money > 0 && <p className="muted small" style={{ margin: 0 }}>{h.money} money item{h.money === 1 ? "" : "s"} went to Caleb. Amounts stay there.</p>}
            {h && h.suspicious.length > 0 && <Digest title="Suspicious, left untouched" hot lines={h.suspicious.map((s) => `${s.subject ?? "(no subject)"}${s.from ? ` · ${s.from}` : ""}${s.why ? ` (${s.why})` : ""}`)} />}
            {h && h.cold.length > 0 && <Digest title="Cold pitches" lines={h.cold.map((c) => `${c.from ?? "Unknown"}${c.subject ? ` · ${c.subject}` : ""}`)} />}
            {box.handled.length > 0 && (
              <>
                <span className="eyebrow">Dealt with · last 3 days</span>
                <ul className="list">{box.handled.map((i) => <li key={i.id}><span className="grow">{i.subject}<span className="muted small block">{i.from_name ?? i.watch ?? ""}{i.done_how ? ` · ${i.done_how}` : ""}</span></span><button className="btn ghost" onClick={() => call(`/api/inbox/item/${i.id}`, json("PATCH", { done: false })).then(load).catch((e) => onError(e.message))}>Put back</button></li>)}</ul>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Digest({ title, lines, hot }: { title: string; lines: string[]; hot?: boolean }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className={hot ? "eyebrow accent" : "eyebrow"}>{title} · {lines.length}</span>
      <ul className="list">{lines.map((l, n) => <li key={n} className="small">{l}</li>)}</ul>
    </div>
  );
}

function Row({ item, open, onToggle, people, connected, stt, hasModel, onError, onDone }: { item: Item; open: boolean; onToggle: () => void; people: Person[]; connected: boolean; stt: boolean; hasModel: boolean; onError: (m: string) => void; onDone: (note: string) => void }) {
  const [full, setFull] = useState<Full | null>(null);
  const [mode, setMode] = useState<null | "reply" | "handoff" | "task" | "ask">(null);
  const [todo, setTodo] = useState("");
  const dt = useDictation(stt, (t) => setTodo((x) => (x ? x + " " : "") + t), onError);
  const [say, setSay] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [cc, setCc] = useState("");
  const [fwd, setFwd] = useState("");
  const [to, setTo] = useState<Person>({ name: item.suggest_name ?? "", email: item.suggest_email ?? "" });
  const [msg, setMsg] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const d = useDictation(stt, (t) => setSay((x) => (x ? x + " " : "") + t), onError);

  useEffect(() => { if (open && full === null && item.can_open) call<Full>(`/api/inbox/item/${item.id}`).then(setFull).catch((e) => onError(e.message)); }, [open, full, item.id, item.can_open, onError]);
  const mailId = full?.mail_id ?? null;
  const run = async (fn: () => Promise<unknown>, after?: string) => { setBusy(true); try { await fn(); if (after) onDone(after); } catch (e) { onError((e as Error).message); } finally { setBusy(false); } };
  const makeDraft = () => run(async () => { const r = await call<{ text: string; note?: string }>(`/api/inbox/${mailId}/draft`, json("POST", { say })); setDraft(r.text); if (r.note) onError(r.note); });
  const hand = (p: Person, note = "") => run(() => call(`/api/inbox/${mailId}/handoff`, json("POST", { ...p, note, remember })), `Handed to ${p.name}.`);
  const clear = (how = "Cleared") => run(() => call(`/api/inbox/item/${item.id}`, json("PATCH", { done: true, how })), "Cleared.");
  const who = item.from_name ?? item.watch ?? "Watch";

  return (
    <div className={open ? "card mail open" : "card mail"}>
      <button className="mail-head" aria-expanded={open} onClick={onToggle}>
        <span className="grow">
          <strong>{who}</strong>{item.status === "new" && <span className="accent small"> · new</span>} <span className="muted small">{ago(item.updated_at)}</span>
          <span className="block">{item.subject}</span>
          {item.summary && <span className="muted small block">{item.summary}</span>}
          {item.need && <span className="small block electro">{item.need}</span>}
        </span>
        {item.due && <span className="status">Due {due(item.due)}</span>}
        {item.category && LABEL[item.category] && <span className="status">{LABEL[item.category]}</span>}
        {item.has_draft && <span className="status ok">Draft ready</span>}
        {item.suggest_name && <span className="status ok">→ {item.suggest_name}</span>}
      </button>
      {open && (
        <div className="pad stack">
          {item.can_open && <p className="handed">{full ? (full.body ?? "Couldn't load this email from Gmail. Open it in Gmail instead.") : "Loading…"}</p>}
          {mode === null && (
            <div className="row">
              {mailId && <button className="btn" onClick={() => { if (full?.draft && draft === null) setDraft(full.draft); setMode("reply"); }}>Reply</button>}
              {mailId && <button className="btn" onClick={() => setMode("handoff")}>Hand off</button>}
              {mailId && <button className="btn" onClick={() => { setTodo(""); setMode("task"); }}>Task for me</button>}
              {mailId && <button className="btn" onClick={() => { setTodo(""); setMode("ask"); }}>Have Hermes do it</button>}
              {item.gmail && <a className="btn ghost" href={item.gmail} target="_blank" rel="noreferrer">Open in Gmail</a>}
              <button className="btn ghost" disabled={busy} onClick={() => clear()}>Done</button>
            </div>
          )}
          {!connected && item.can_open && mode === null && <p className="muted small" style={{ margin: 0 }}>Replying and handing off here need your Gmail login in Settings.</p>}
          {mode === "reply" && mailId && (
            <div className="form">
              {draft === null ? (
                <>
                  <label htmlFor={`say${item.id}`} className="eyebrow">What do you want to tell them?</label>
                  <div className="row" style={{ alignItems: "flex-start" }}>
                    <textarea id={`say${item.id}`} className="plain grow" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : hasModel ? "Say the gist. It writes the email for you to check." : "Type or say the reply."} value={say} onChange={(e) => setSay(e.target.value)} />
                    <MicButton d={d} small />
                  </div>
                  <div className="row"><button className="btn" disabled={busy || !say.trim()} onClick={makeDraft}>{busy ? "Writing…" : "Write the reply"}</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
                </>
              ) : (
                <>
                  <label htmlFor={`dr${item.id}`} className="eyebrow">Reply to {who}{full?.draft && draft === full.draft ? " · Hermes's draft" : ""} · check it, change it</label>
                  <textarea id={`dr${item.id}`} className="plain tall" value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <div className="fields">
                    <label htmlFor={`cc${item.id}`}>CC<input id={`cc${item.id}`} type="text" inputMode="email" autoCapitalize="off" placeholder="optional" value={cc} onChange={(e) => setCc(e.target.value)} /></label>
                    <label htmlFor={`fw${item.id}`}>Also forward the thread to<input id={`fw${item.id}`} type="text" inputMode="email" autoCapitalize="off" placeholder="optional" value={fwd} onChange={(e) => setFwd(e.target.value)} /></label>
                  </div>
                  <div className="row">
                    <button className="btn" disabled={busy || !draft.trim()} onClick={() => run(() => call(`/api/inbox/${mailId}/send`, json("POST", { text: draft, cc, forward_to: fwd })), `Reply sent to ${who}.`)}>{busy ? "Sending…" : "Send"}</button>
                    <button className="btn ghost" onClick={() => setDraft(null)}>Start over</button>
                    <button className="btn ghost" onClick={() => { setMode(null); setDraft(null); }}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
          {(mode === "task" || mode === "ask") && mailId && (
            <div className="form">
              <label htmlFor={`td${item.id}`} className="eyebrow">{mode === "task" ? "What do you need to do about this?" : "What should Hermes do with this email?"}</label>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <textarea id={`td${item.id}`} className="plain grow" placeholder={dt.recording ? `Listening… ${dt.clock}` : dt.busy ? "Writing it down…" : mode === "task" ? "e.g. Sign the contract by Friday, important" : "e.g. Make a note of the affiliate details for a later tutorial"} value={todo} onChange={(e) => setTodo(e.target.value)} />
                <MicButton d={dt} small />
              </div>
              <p className="muted small" style={{ margin: 0 }}>{mode === "task" ? "It goes on your deck with a note saying which email it's about, and leaves the Inbox." : "Hermes gets your instruction and this email. Its answer shows at the top of your deck."}</p>
              <div className="row">
                {mode === "task"
                  ? <button className="btn" disabled={busy || !todo.trim()} onClick={() => run(() => call(`/api/inbox/${mailId}/task`, json("POST", { text: todo })), "Task added to your deck.")}>Add task</button>
                  : <button className="btn" disabled={busy || !todo.trim()} onClick={() => run(async () => { await call("/api/asks", json("POST", { text: todo, mail_id: mailId })); await call(`/api/inbox/item/${item.id}`, json("PATCH", { done: true, how: "Given to Hermes" })); }, "Handed to Hermes. The answer will be on your deck.")}>Hand to Hermes</button>}
                <button className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
              </div>
            </div>
          )}
          {mode === "handoff" && mailId && (
            <div className="form">
              {people.length > 0 && <div className="row">{people.map((p) => <button key={p.email} type="button" className="status" aria-pressed={to.email === p.email} style={to.email === p.email ? { background: "#fff", color: "#0d101c" } : undefined} onClick={() => setTo(p)}>{p.name}</button>)}</div>}
              <div className="fields">
                <label htmlFor={`hn${item.id}`}>Who<input id={`hn${item.id}`} type="text" value={to.name} onChange={(e) => setTo({ ...to, name: e.target.value })} /></label>
                <label htmlFor={`he${item.id}`}>Their email<input id={`he${item.id}`} type="email" autoCapitalize="off" value={to.email} onChange={(e) => setTo({ ...to, email: e.target.value })} /></label>
              </div>
              <label htmlFor={`hm${item.id}`} className="eyebrow">Note to them (optional)</label>
              <textarea id={`hm${item.id}`} className="plain" value={msg} onChange={(e) => setMsg(e.target.value)} />
              <label className="check" htmlFor={`hr${item.id}`}><input id={`hr${item.id}`} type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>Suggest them next time {full?.from_addr ?? "this sender"} writes</span></label>
              <div className="row"><button className="btn" disabled={busy || !to.name.trim() || !to.email.trim()} onClick={() => hand(to, msg)}>{busy ? "Sending…" : "Forward and hand off"}</button><button className="btn ghost" onClick={() => setMode(null)}>Cancel</button></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
