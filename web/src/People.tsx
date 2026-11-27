import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { json } from "./api";
import { LockGate, type Session } from "./Lock";
import { MicButton, ScreenHead, useDictation } from "./ui";

type Props = { onBack: () => void; onError: (m: string) => void; stt?: boolean };
type Go = (screen: Screen) => void;
type Screen = { at: "home" } | { at: "person"; id: number } | { at: "scenario"; id: number } | { at: "reading"; id: number; from: Screen } | { at: "records" } | { at: "library" } | { at: "inbox" };
interface Ref { id: number; name: string }
interface Step { id: number; title: string; done_at: string | null }
interface Goal { id: number; kind: string; person_id: number | null; title: string; done_looks_like: string | null; stage: string | null; next_action: string | null; next_due: string | null; steps: Step[]; current_step: number | null; step_number: number; people: Ref[]; days_quiet: number | null }
interface Entry { id: number; ts: string; text: string; outcome: string | null; kind: string; quotes: string[]; file_id: number | null; person_name?: string }

const when = (iso: string) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
const day = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00").toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" }) : d);
const quiet = (d: number | null) => (d === null ? "Nothing recorded yet" : d === 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago`);
const GRADE_NAMES: Record<string, string> = { O: "Observed", E: "Established", C: "Clinical", F: "Folklore that works", "?": "Contested", "O:ben": "You said it", "O:sys": "From a capture", "O:inf": "A guess" };

export function People({ onBack, onError, stt }: Props) {
  return (
    <LockGate name="people" title="People" onBack={onBack} note="Nothing in here shows on the deck beyond “something due”. It is answered only by People's own model, never by Claude or ChatGPT.">
      {(s) => <Inside s={s} onBack={onBack} onError={onError} stt={Boolean(stt)} />}
    </LockGate>
  );
}

function Inside({ s, onBack, onError, stt }: { s: Session; stt: boolean } & Props) {
  const [screen, setScreen] = useState<Screen>({ at: "home" });
  const p = { s, go: setScreen, onError, stt };
  switch (screen.at) {
    case "person": return <PersonScreen {...p} id={screen.id} />;
    case "scenario": return <ScenarioScreen {...p} id={screen.id} />;
    case "reading": return <ReadingScreen {...p} id={screen.id} from={screen.from} />;
    case "records": return <RecordsScreen {...p} />;
    case "library": return <LibraryScreen {...p} />;
    case "inbox": return <InboxScreen {...p} />;
    default: return <Home {...p} onBack={onBack} />;
  }
}
type In = { s: Session; go: Go; onError: (m: string) => void; stt: boolean };

function useLoad<T>(s: Session, path: string, onError: (m: string) => void): [T | null, () => Promise<void>] {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(() => s.call<T>(path).then(setData).catch((e) => onError(e.message)), [s, path, onError]);
  useEffect(() => { load(); }, [load]);
  return [data, load];
}
const Sub = ({ title, go, to = { at: "home" }, right }: { title: string; go: Go; to?: Screen; right?: ReactNode }) => (
  <div className="screen-head"><button className="btn ghost back" onClick={() => go(to)}>‹ {to.at === "home" ? "People" : "Back"}</button><div className="screen-title"><h1>{title}</h1></div><div className="screen-right">{right}</div></div>
);

/* ---------- Home: guidance first ---------- */
interface Item { key: string; kind: string; person_id: number | null; goal_id: number; name: string; about: string; stage: string | null; next_action: string | null; next_due: string | null; days_quiet: number | null; threads: string[]; step: string | null }
interface DoNow { what: string; when: string | null; key: string; who: string | null; goal_id: number | null; is_next: boolean }
interface Brief { summary: string; points: string[]; do_now: DoNow[]; items: Record<string, { guidance: string[]; next: string }>; ts: string | null; by: "model" | "rules" }
interface Deep { id: number; ts: string; read: string; points: string[]; watch_for: string; next: { what: string; when: string | null } | null; words: { text: string; source: number } | null }
const today = () => new Date().toLocaleDateString("en-CA");

function Home({ s, go, onError, stt, onBack }: In & { onBack: () => void }) {
  const [h, setH] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const askBox = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const tried = useRef(false);

  const load = useCallback(async () => { const v = await s.call<any>("/api/people/home"); setH(v); return v; }, [s]);
  const refresh = useCallback(async (quiet = false) => {
    setRefreshing(true); setRefreshNote(null);
    try { await s.call("/api/people/brief", { method: "POST" }); await load(); }
    catch (e) { if (quiet) setRefreshNote((e as Error).message); else onError((e as Error).message); }
    finally { setRefreshing(false); }
  }, [s, load, onError]);
  // After anything changes, show it at once and let the guidance catch up behind it.
  const changed = useCallback(async () => { try { const v = await load(); if (v.brief_stale) refresh(true); } catch (e) { onError((e as Error).message); } }, [load, refresh, onError]);
  useEffect(() => { load().then((v) => { if (v.brief_stale && !tried.current) { tried.current = true; refresh(true); } }).catch((e) => onError(e.message)); }, [load, refresh, onError]);

  if (!h) return <p className="muted">Loading…</p>;
  const b: Brief = h.brief;
  const did = (goalId: number, what?: string) => s.call(`/api/people/goals/${goalId}/did`, json("POST", { what })).then(changed).catch((e) => onError(e.message));
  const askAbout = (name: string) => { setDraft(`${name}: `); askBox.current?.focus(); askBox.current?.scrollIntoView({ behavior: "smooth", block: "center" }); };
  const background = [h.inbox ? `${h.inbox} note${h.inbox === 1 ? "" : "s"} to sort` : "", h.unplaced.length ? `${h.unplaced.length} handed over without a goal` : ""].filter(Boolean);

  return (
    <div className="stack">
      <ScreenHead title="People" onBack={onBack} right={<button className="btn" onClick={s.lock}>Lock now</button>} />

      <section className="card pad hot stack guide">
        <div className="row">
          <span className="eyebrow accent grow">Guidance</span>
          {h.has_model && <button className="btn ghost" onClick={() => refresh()} disabled={refreshing}>{refreshing ? "Updating…" : "Refresh"}</button>}
        </div>
        <p className="guide-summary">{b.summary || "Nothing to say yet."}</p>
        {b.do_now.length > 0 && (
          <div className="stack tight">
            <span className="eyebrow">Do now</span>
            <ul className="list">
              {b.do_now.map((d, i) => (
                <li key={i}>
                  <span className="grow">{d.what}{(d.who || d.when) && <span className="muted small block">{[d.who, d.when && day(d.when)].filter(Boolean).join(" · ")}</span>}</span>
                  {d.key === "inbox" ? <button className="btn ghost" onClick={() => go({ at: "inbox" })}>Sort</button>
                    : d.goal_id ? <button className="btn ghost" onClick={() => did(d.goal_id!, d.is_next ? undefined : d.what)}>Done</button> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {b.points.length > 0 && <ul className="guide-points">{b.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        <span className="muted small">
          {refreshing ? "Catching up on what's changed…" : b.by === "model" && b.ts ? `Written ${when(b.ts)}${h.brief_stale ? " · something has changed since" : ""}` : h.has_model ? "From your dates and notes so far." : "From your dates and notes. Set a model for People in Settings for written guidance."}
          {refreshNote && <> · Couldn't update: {refreshNote}</>}
        </span>
      </section>

      <AskBox s={s} stt={stt} onError={onError} chat={h.chat} draft={draft} setDraft={setDraft} box={askBox} onDone={changed} />

      <section className="stack">
        <span className="eyebrow">Who and what</span>
        {h.items.length === 0 && <p className="muted small">No one yet. Tell it about someone above, or hand notes over from Hermes.</p>}
        <ul className="ppl">
          {h.items.map((i: Item) => (
            <PersonRow key={i.key} s={s} go={go} onError={onError} i={i} g={b.items[i.key]} open={open === i.key} hasModel={h.has_model}
              toggle={() => setOpen(open === i.key ? null : i.key)} onAsk={askAbout} onDid={() => did(i.goal_id)} onChanged={changed} />
          ))}
        </ul>
      </section>

      <div className="stack tight">
        <button className="linkish" onClick={() => go({ at: "records" })}>Records, library and the Telegram link ›{background.length ? ` (${background.join(", ")})` : ""}</button>
        <span className="muted small">Answered only by People's own model, never Claude or ChatGPT. Locks itself after {s.idleMinutes} minutes idle.</span>
      </div>
    </div>
  );
}

function AskBox({ s, stt, onError, chat, draft, setDraft, box, onDone }: { s: Session; stt: boolean; onError: (m: string) => void; chat: Array<{ id: number; role: string; text: string }>; draft: string; setDraft: (v: string | ((x: string) => string)) => void; box: React.RefObject<HTMLTextAreaElement>; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [did, setDid] = useState<string[]>([]);
  const [history, setHistory] = useState<Array<{ id: number; role: string; text: string }> | null>(null);
  const d = useDictation(stt, (t) => setDraft((x) => (x.trim() ? x.trimEnd() + " " : "") + t), onError);
  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy || (!draft.trim() && !files.length)) return;
    setBusy(true);
    const data = new FormData();
    data.set("text", draft);
    files.forEach((f) => data.append("file", f));
    try { const r = await s.call<{ did: string[] }>("/api/people/ask", { method: "POST", body: data }); setDraft(""); setFiles([]); setDid(r.did); setHistory(null); onDone(); }
    catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  };
  const shown = history ?? chat;
  return (
    <form className="card pad stack" onSubmit={send}>
      <label htmlFor="ask" className="eyebrow">Ask or add</label>
      <textarea id="ask" ref={box} className="plain" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
        placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : "Ask anything, or tell it what happened. Paste a chat, attach screenshots or files."} />
      {files.length > 0 && <div className="row">{files.map((f, i) => <span key={i} className="status">{f.name}<button type="button" className="chip-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button></span>)}</div>}
      <div className="row">
        <MicButton d={d} small />
        <label className="btn ghost as-link attach">Attach<input className="sr" type="file" multiple accept="image/*,.pdf,.txt,.md,.markdown,.csv,text/*" onChange={(e) => { setFiles([...files, ...[...(e.target.files ?? [])]].slice(0, 6)); e.target.value = ""; }} /></label>
        <span className="grow" />
        <button className="btn primary" type="submit" disabled={busy || (!draft.trim() && !files.length)}>{busy ? "Thinking…" : "Send"}</button>
      </div>
      {(shown.length > 0 || busy) && (
        <div className="chat">
          {shown.map((m) => <div key={m.id} className={m.role === "user" ? "bubble me" : "bubble"}>{m.text}</div>)}
          {did.length > 0 && !history && <div className="row">{did.map((x, i) => <span key={i} className="status ok">{x}</span>)}</div>}
        </div>
      )}
      {chat.length > 0 && !history && <button type="button" className="linkish small" onClick={() => s.call<{ messages: any[] }>("/api/people/chat").then((r) => setHistory(r.messages.slice(-12))).catch((e) => onError(e.message))}>Earlier</button>}
    </form>
  );
}

function PersonRow({ s, go, onError, i, g, open, hasModel, toggle, onAsk, onDid, onChanged }: { s: Session; go: Go; onError: (m: string) => void; i: Item; g?: { guidance: string[]; next: string }; open: boolean; hasModel: boolean; toggle: () => void; onAsk: (name: string) => void; onDid: () => void; onChanged: () => void }) {
  const [deep, setDeep] = useState<Deep | null>(null);
  const [thinking, setThinking] = useState(false);
  useEffect(() => { if (open) s.call<{ guide: Deep | null }>(`/api/people/guide?key=${i.key}`).then((r) => setDeep(r.guide)).catch(() => {}); }, [open, s, i.key]);
  const due = Boolean(i.next_due && i.next_due <= today());
  const line = i.next_action ? `Next: ${i.next_action}${i.next_due ? ` · ${day(i.next_due)}` : ""}` : g?.next ? `Suggested: ${g.next}` : "No next step yet";
  const deeper = async () => {
    setThinking(true);
    try { setDeep((await s.call<{ guide: Deep }>("/api/people/guide", json("POST", { key: i.key }))).guide); } catch (e) { onError((e as Error).message); } finally { setThinking(false); }
  };
  const record: Screen = i.kind === "relationship" ? { at: "person", id: i.person_id! } : { at: "scenario", id: i.goal_id };
  return (
    <li className={open ? "ppl-item open" : "ppl-item"}>
      <button className="ppl-head" aria-expanded={open} onClick={toggle}>
        <span className="ppl-top"><span className="ppl-name">{i.name}</span>{due && <span className="status hot">Due</span>}<span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span></span>
        {i.about && <span className="muted small">{i.kind === "scenario" ? "Outcome · " : ""}{i.about}</span>}
        <span className={i.next_action ? "small accent" : "small muted"}>{line}</span>
      </button>
      {open && (
        <div className="ppl-body stack">
          {g?.guidance.length ? <ul className="guide-points">{g.guidance.map((x, k) => <li key={k}>{x}</li>)}</ul> : <p className="muted small">No guidance on this one yet.</p>}
          {(i.threads.length > 0 || i.step || i.kind === "relationship") && (
            <p className="muted small" style={{ margin: 0 }}>{[i.kind === "relationship" ? `Last contact: ${quiet(i.days_quiet).toLowerCase()}` : "", i.step ?? "", i.threads.length ? `Open: ${i.threads.join(" · ")}` : ""].filter(Boolean).join(" · ")}</p>
          )}
          {deep && (
            <div className="deep stack tight">
              <span className="eyebrow electro">Deeper · {when(deep.ts)}</span>
              {deep.read && <p style={{ margin: 0 }}>{deep.read}</p>}
              <ul className="guide-points">{deep.points.map((x, k) => <li key={k}>{x}</li>)}</ul>
              {deep.watch_for && <span className="muted small">Watch for: {deep.watch_for}</span>}
              {deep.words && <span className="small">“{deep.words.text}”</span>}
              {deep.next && (
                <div className="row">
                  <span className="accent grow">Next: {deep.next.what}{deep.next.when ? ` · ${day(deep.next.when)}` : ""}</span>
                  {deep.next.what !== i.next_action && <button className="btn ghost" onClick={() => s.call(`/api/people/guide/${deep.id}/use`, { method: "POST" }).then(onChanged).catch((e) => onError(e.message))}>Make it the next step</button>}
                </div>
              )}
            </div>
          )}
          <div className="row">
            {hasModel && <button className="btn" onClick={deeper} disabled={thinking}>{thinking ? "Thinking…" : deep ? "Go deeper again" : "Go deeper"}</button>}
            <button className="btn ghost" onClick={() => onAsk(i.kind === "relationship" ? i.name.split(" ")[0] : i.name)}>Ask about this</button>
            {i.next_action && <button className="btn ghost" onClick={onDid}>Did the next step</button>}
            <span className="grow" />
            <button className="linkish small" onClick={() => go(record)}>Full record ›</button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ---------- Records: everything kept in the background ---------- */
function RecordsScreen({ s, go, onError }: In) {
  const [h, load] = useLoad<any>(s, "/api/people/home", onError);
  const [adding, setAdding] = useState<null | "relationship" | "scenario">(null);
  const [f, setF] = useState({ name: "", how_met: "", building_toward: "", title: "", done_looks_like: "", steps: "", people: [] as number[] });
  const [token, setToken] = useState<string | null>(null);
  if (!h) return <p className="muted">Loading…</p>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (adding === "relationship") { const p = await s.call<Ref>("/api/people/persons", json("POST", f)); go({ at: "person", id: p.id }); }
      else { const g = await s.call<Goal>("/api/people/goals", json("POST", { kind: "scenario", title: f.title, done_looks_like: f.done_looks_like, people: f.people, steps: f.steps.split("\n") })); go({ at: "scenario", id: g.id }); }
    } catch (err) { onError((err as Error).message); }
  };
  const Card = ({ name, sub, to }: { name: string; sub: string; to: Screen }) => <button className="card pad trip-card" onClick={() => go(to)}><span className="module-name">{name}</span><span className="muted small">{sub}</span></button>;
  return (
    <div className="stack">
      <Sub title="Records" go={go} />
      <p className="muted small" style={{ margin: 0 }}>The full notes behind the guidance. You don't need to keep these up by hand: telling it things on the main page fills them in.</p>

      <div className="row">
        <button className="btn" onClick={() => go({ at: "inbox" })}>Handed over{h.inbox ? ` · ${h.inbox}` : ""}</button>
        <button className="btn" onClick={() => go({ at: "library" })}>Library</button>
        <button className="btn ghost" onClick={() => setAdding(adding === "relationship" ? null : "relationship")}>+ Person</button>
        <button className="btn ghost" onClick={() => setAdding(adding === "scenario" ? null : "scenario")}>+ Scenario</button>
      </div>

      {adding && (
        <form className="card pad form" onSubmit={save}>
          <span className="eyebrow">{adding === "relationship" ? "New person" : "New scenario"}</span>
          {adding === "relationship" ? (
            <div className="fields">
              <label htmlFor="pn">Who<input id="pn" type="text" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
              <label htmlFor="pm">How did you meet?<input id="pm" type="text" value={f.how_met} onChange={(e) => setF({ ...f, how_met: e.target.value })} /></label>
              <label htmlFor="pb">What do you want this to be?<input id="pb" type="text" required value={f.building_toward} onChange={(e) => setF({ ...f, building_toward: e.target.value })} /></label>
            </div>
          ) : (
            <>
              <div className="fields">
                <label htmlFor="st">The outcome you want<input id="st" type="text" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
                <label htmlFor="sd">How you'd know it happened<input id="sd" type="text" value={f.done_looks_like} onChange={(e) => setF({ ...f, done_looks_like: e.target.value })} /></label>
              </div>
              <label htmlFor="ss" className="eyebrow">The path, one step per line</label>
              <textarea id="ss" className="plain" value={f.steps} onChange={(e) => setF({ ...f, steps: e.target.value })} />
              {h.people.length > 0 && <div className="row">{h.people.map((p: Ref) => <button type="button" key={p.id} className="status" aria-pressed={f.people.includes(p.id)} onClick={() => setF({ ...f, people: f.people.includes(p.id) ? f.people.filter((x) => x !== p.id) : [...f.people, p.id] })}>{f.people.includes(p.id) ? "✓ " : ""}{p.name}</button>)}</div>}
            </>
          )}
          <div className="row"><button className="btn" type="submit">Add</button><button className="btn ghost" type="button" onClick={() => setAdding(null)}>Cancel</button></div>
        </form>
      )}

      {h.relationships.length > 0 && <section className="stack"><span className="eyebrow">Relationships</span><div className="grid-2">{h.relationships.map((g: Goal) => <Card key={g.id} name={g.people[0]?.name ?? "?"} sub={`${g.title} · ${quiet(g.days_quiet)}`} to={{ at: "person", id: g.person_id! }} />)}</div></section>}
      {h.scenarios.length > 0 && <section className="stack"><span className="eyebrow">Scenarios</span><div className="grid-2">{h.scenarios.map((g: Goal) => <Card key={g.id} name={g.title} sub={g.people.length ? `With ${g.people.map((x) => x.name).join(", ")}` : "No one named yet"} to={{ at: "scenario", id: g.id }} />)}</div></section>}
      {h.unplaced.length > 0 && (
        <section className="stack">
          <span className="eyebrow electro">On record, no goal yet · {h.unplaced.length}</span>
          <p className="muted small" style={{ margin: 0 }}>Open one to say what you want it to be, merge it into someone else, or remove it.</p>
          <div className="grid-2">{h.unplaced.map((p: any) => <Card key={p.id} name={p.name} sub={`${p.notes} note${p.notes === 1 ? "" : "s"}${p.facts ? ` · ${p.facts} detail${p.facts === 1 ? "" : "s"}` : ""}${p.imported ? " · from Hermes" : ""}`} to={{ at: "person", id: p.id }} />)}</div>
        </section>
      )}

      <section className="card pad stack">
        <span className="eyebrow">Telegram, through Hermes</span>
        <p className="muted small" style={{ margin: 0 }}>A token of its own lets Hermes ask People and add to it when you talk to it on Telegram. Give it only to Hermes's private model. Claude and ChatGPT never get it, and the deck's relay token can't read People.</p>
        {token ? (
          <div className="token"><p className="small">Paste this into Hermes on the Umbrel. It's shown only now.</p><code>{token}</code></div>
        ) : <p className="small muted" style={{ margin: 0 }}>{h.linked ? "Hermes has a token. Making a new one stops the old one working." : "Not linked."}</p>}
        <div className="row">
          <button className="btn" onClick={() => s.call<{ token: string }>("/api/people/link-token", { method: "POST" }).then((r) => { setToken(r.token); load(); }).catch((e) => onError(e.message))}>{h.linked ? "Make a new token" : "Make a token"}</button>
          {h.linked && <button className="btn ghost" onClick={() => s.call("/api/people/link-token", { method: "DELETE" }).then(() => { setToken(null); load(); }).catch((e) => onError(e.message))}>Unlink</button>}
        </div>
      </section>
    </div>
  );
}

/* ---------- Shared: the next-move editor and the note form ---------- */
function GoalCard({ s, g, onChanged, onError, label }: { s: Session; g: Goal; onChanged: () => void; onError: (m: string) => void; label: string }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ title: g.title, stage: g.stage ?? "", next_action: g.next_action ?? "", next_due: g.next_due ?? "" });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await s.call(`/api/people/goals/${g.id}`, json("PATCH", f)); setEdit(false); onChanged(); } catch (err) { onError((err as Error).message); }
  };
  if (!edit) return (
    <section className="card pad hot stack">
      <span className="eyebrow accent">{label}</span>
      <span style={{ fontSize: 17 }}>{g.title}</span>
      {g.stage && <span className="muted small">Where it is now: {g.stage}</span>}
      <span className={g.next_action ? "accent" : "muted"}>{g.next_action ? `Next: ${g.next_action}${g.next_due ? ` · ${day(g.next_due)}` : ""}` : "No next move set"}</span>
      <div className="row"><button className="btn" onClick={() => setEdit(true)}>Change</button></div>
    </section>
  );
  return (
    <form className="card pad hot form" onSubmit={save}>
      <span className="eyebrow accent">{label}</span>
      <div className="fields">
        <label htmlFor="gt">{label}<input id="gt" type="text" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label htmlFor="gs">Where it is now<input id="gs" type="text" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })} /></label>
        <label htmlFor="ga">Next move<input id="ga" type="text" value={f.next_action} onChange={(e) => setF({ ...f, next_action: e.target.value })} /></label>
        <label htmlFor="gd">When<input id="gd" type="date" value={f.next_due} onChange={(e) => setF({ ...f, next_due: e.target.value })} /></label>
      </div>
      <p className="muted small">A next move needs a date, or to be a named re-ask.</p>
      <div className="row"><button className="btn" type="submit">Save</button><button className="btn ghost" type="button" onClick={() => setEdit(false)}>Cancel</button></div>
    </form>
  );
}

function NoteForm({ s, stt, people, personId, goalId, outcomes, onSaved, onError }: { s: Session; stt: boolean; people?: Ref[]; personId?: number; goalId?: number; outcomes: string[]; onSaved: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [who, setWho] = useState<number | "">(personId ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [spoken, setSpoken] = useState(false);
  const d = useDictation(stt, (t) => { setText((x) => (x ? x + " " : "") + t); setSpoken(true); }, onError);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const data = new FormData();
    data.set("person_id", String(who)); data.set("text", text); if (outcome) data.set("outcome", outcome); if (goalId) data.set("goal_id", String(goalId)); if (spoken) data.set("kind", "voice"); if (file) data.set("file", file);
    try { await s.call("/api/people/interactions", { method: "POST", body: data }); setText(""); setOutcome(null); setFile(null); setSpoken(false); onSaved(); } catch (err) { onError((err as Error).message); }
  };
  return (
    <form className="card pad form" onSubmit={save}>
      <label htmlFor="nt" className="eyebrow">What happened</label>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <textarea id="nt" className="plain grow" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : 'Their exact words in "quotes" are kept as quotes.'} value={text} onChange={(e) => setText(e.target.value)} />
        <MicButton d={d} small />
      </div>
      {people && <label htmlFor="nw" className="eyebrow">Who with<select id="nw" required value={who} onChange={(e) => setWho(Number(e.target.value))}><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <div className="row">{outcomes.map((o) => <button type="button" key={o} className="status" aria-pressed={outcome === o} style={outcome === o ? { background: "#fff", color: "#0d101c" } : undefined} onClick={() => setOutcome(outcome === o ? null : o)}>{o}</button>)}</div>
      <label className="btn as-link upload">{file ? `Screenshot: ${file.name}` : "Attach a screenshot"}<input className="sr" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <p className="muted small">Once saved, a note can't be rewritten. Corrections go in as a new note.</p>
      <div className="row"><button className="btn" type="submit" disabled={!text.trim() && !file}>Save</button></div>
    </form>
  );
}

const Log = ({ log }: { log: Entry[] }) => log.length === 0 ? <p className="muted small">Nothing recorded yet.</p> : (
  <ul className="list">
    {log.map((i) => (
      <li key={i.id} style={{ alignItems: "flex-start" }}>
        <span className="when small muted">{when(i.ts)}{i.outcome && <><br /><span className="electro">{i.outcome}</span></>}</span>
        <span className="grow">{i.person_name && <strong>{i.person_name}: </strong>}{i.text}{i.file_id && <> · <a href={`/api/people/files/${i.file_id}`} target="_blank" rel="noreferrer">screenshot</a></>}</span>
      </li>
    ))}
  </ul>
);

/* ---------- A person ---------- */
function PersonScreen({ s, go, onError, stt, id }: In & { id: number }) {
  const [v, load] = useLoad<any>(s, `/api/people/persons/${id}`, onError);
  const [shown, setShown] = useState<number[]>([]);
  const [legend, setLegend] = useState(false);
  const [fact, setFact] = useState({ label: "", value: "", sensitive: false });
  const [thread, setThread] = useState("");
  const [toward, setToward] = useState("");
  const [manage, setManage] = useState(false);
  const [name, setName] = useState("");
  const [into, setInto] = useState("");
  const [sure, setSure] = useState(false);
  if (!v) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  const leave = async (fn: () => Promise<unknown>, to: Screen) => { try { await fn(); go(to); } catch (e) { onError((e as Error).message); } };
  const here: Screen = { at: "person", id };
  return (
    <div className="stack">
      <Sub title={v.person.name} go={go} right={<button className="btn ghost" aria-expanded={legend} onClick={() => setLegend(!legend)}>Tags</button>} />
      <p className="muted" style={{ margin: 0 }}>{quiet(v.days_quiet)}{v.person.how_met ? ` · met: ${v.person.how_met}` : ""}</p>
      {legend && <section className="card pad"><ul className="list">{Object.entries(GRADE_NAMES).map(([k, n]) => <li key={k}><code>[{k}]</code><span>{n}</span></li>)}</ul></section>}

      {v.goal ? <GoalCard s={s} g={v.goal} onChanged={load} onError={onError} label="Building toward" /> : (
        <form className="card pad hot form" onSubmit={(e) => { e.preventDefault(); act(() => s.call("/api/people/goals", json("POST", { kind: "relationship", person_id: id, title: toward }))); }}>
          <label htmlFor="tw" className="eyebrow accent">What do you want this to be?</label>
          <input id="tw" type="text" required value={toward} onChange={(e) => setToward(e.target.value)} />
          <div className="row"><button className="btn" type="submit">Set</button></div>
        </form>
      )}
      {v.scenarios.map((x: any) => <button key={x.id} className="linkish" onClick={() => go({ at: "scenario", id: x.id })}>Part of scenario: {x.title} ›</button>)}

      <section className="card pad stack">
        <span className="eyebrow accent">Open between you</span>
        {v.threads.length === 0 && <p className="muted small">No open questions.</p>}
        <ul className="list">{v.threads.map((t: any) => <li key={t.id}><span className="grow">{t.question}<span className="muted small block">Opened {when(t.opened_at)}</span></span><button className="btn ghost" onClick={() => act(() => s.call(`/api/people/threads/${t.id}/close`, { method: "POST" }))}>Settled</button></li>)}</ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); act(async () => { await s.call("/api/people/threads", json("POST", { person_id: id, question: thread })); setThread(""); }); }}>
          <label htmlFor="th" className="sr">New open question</label>
          <input id="th" className="grow plain-input" type="text" placeholder="An open question between you" value={thread} onChange={(e) => setThread(e.target.value)} />
          <button className="btn" type="submit" disabled={!thread.trim()}>Add</button>
        </form>
      </section>

      <section className="card pad stack">
        <span className="eyebrow">What they've said · word for word</span>
        {v.quotes.length === 0 ? <p className="muted small">No quotes yet. Put their exact words in "quotes" when you add a note.</p> : (
          <ul className="list">{v.quotes.slice(0, 12).map((q: any, i: number) => <li key={i}><span className="grow">“{q.text}”<span className="muted small block">{when(q.ts)} · <code>[{q.grade}]</code></span></span></li>)}</ul>
        )}
      </section>

      <section className="stack">
        <span className="eyebrow">Context</span>
        {v.facts.length === 0 && <p className="muted small">What do they do? What do they like? What should you avoid?</p>}
        {v.facts.map((x: any) => {
          const hidden = x.sensitive && !shown.includes(x.id);
          return (
            <div key={x.id} className={x.grade === "O:inf" ? "fact guess" : "fact"}>
              <span className="fact-label muted small">{x.label}</span>
              {hidden ? <button className="blurred grow" onClick={() => setShown([...shown, x.id])}><span aria-hidden="true" />Tap to show</button> : <span className="grow">{x.value}</span>}
              <code className={x.grade === "O:inf" ? "accent" : "muted"}>[{x.grade}]</code>
              {x.grade === "O:inf" && <button className="btn ghost" onClick={() => act(() => s.call(`/api/people/facts/${x.id}/confirm`, { method: "POST" }))}>It's true</button>}
              <button className="btn ghost" aria-label={`Remove ${x.label}`} onClick={() => act(() => s.call(`/api/people/facts/${x.id}`, { method: "DELETE" }))}>✕</button>
            </div>
          );
        })}
        <form className="card pad form" onSubmit={(e) => { e.preventDefault(); act(async () => { await s.call("/api/people/facts", json("POST", { person_id: id, ...fact })); setFact({ label: "", value: "", sensitive: false }); }); }}>
          <div className="fields">
            <label htmlFor="fl">Label<input id="fl" type="text" placeholder="Does, Likes, Avoid…" required value={fact.label} onChange={(e) => setFact({ ...fact, label: e.target.value })} /></label>
            <label htmlFor="fv">Detail<input id="fv" type="text" required value={fact.value} onChange={(e) => setFact({ ...fact, value: e.target.value })} /></label>
          </div>
          <label className="check" htmlFor="fs"><input id="fs" type="checkbox" checked={fact.sensitive} onChange={(e) => setFact({ ...fact, sensitive: e.target.checked })} /><span>Keep this one blurred until tapped</span></label>
          <div className="row"><button className="btn" type="submit">Add detail</button></div>
        </form>
      </section>

      <NoteForm s={s} stt={stt} personId={id} outcomes={v.outcomes} onSaved={load} onError={onError} />

      <section className="card pad stack"><span className="eyebrow">The record</span><Log log={v.log} /></section>

      <section className="stack">
        <button className="linkish" aria-expanded={manage} onClick={() => { setManage(!manage); setName(v.person.name); setSure(false); }}>Rename, merge or remove {manage ? "▾" : "▸"}</button>
        {manage && (
          <div className="card pad form">
            <form className="row" onSubmit={(e) => { e.preventDefault(); act(() => s.call(`/api/people/persons/${id}`, json("PATCH", { name }))); }}>
              <label htmlFor="rn" className="sr">Name</label>
              <input id="rn" className="grow plain-input" type="text" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn" type="submit" disabled={!name.trim() || name === v.person.name}>Rename</button>
            </form>
            {v.others.length > 0 && (
              <div className="row">
                <select className="inline grow" aria-label="Merge into" value={into} onChange={(e) => setInto(e.target.value)}><option value="">Same person as…</option>{v.others.map((p: Ref) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                <button className="btn" disabled={!into} onClick={() => leave(() => s.call(`/api/people/persons/${id}/merge`, json("POST", { into: Number(into) })), { at: "person", id: Number(into) })}>Merge into them</button>
              </div>
            )}
            <div className="row">
              {!sure ? <button className="btn ghost" onClick={() => setSure(true)}>Remove {v.person.name}…</button> : (
                <><span className="accent small grow">This deletes every note, detail and reading about {v.person.name}. It can't be undone.</span><button className="btn" onClick={() => leave(() => s.call(`/api/people/persons/${id}`, { method: "DELETE" }), { at: "home" })}>Yes, remove</button><button className="btn ghost" onClick={() => setSure(false)}>Keep</button></>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="row">
        <button className="btn" onClick={() => s.call<{ id: number }>("/api/people/readings", json("POST", { person_id: id })).then((r) => go({ at: "reading", id: r.id, from: here })).catch((e) => onError(e.message))}>Guide me on this</button>
        {v.reading && <button className="btn ghost" onClick={() => go({ at: "reading", id: v.reading.id, from: here })}>Last reading · {when(v.reading.ts)}</button>}
      </div>
    </div>
  );
}

/* ---------- A scenario ---------- */
function ScenarioScreen({ s, go, onError, stt, id }: In & { id: number }) {
  const [v, load] = useLoad<any>(s, `/api/people/goals/${id}`, onError);
  const [step, setStep] = useState("");
  const [passage, setPassage] = useState<any>(null);
  if (!v) return <p className="muted">Loading…</p>;
  const g: Goal = v.goal;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  const here: Screen = { at: "scenario", id };
  const togglePerson = (pid: number) => act(() => s.call(`/api/people/goals/${id}`, json("PATCH", { people: g.people.some((p) => p.id === pid) ? g.people.filter((p) => p.id !== pid).map((p) => p.id) : [...g.people.map((p) => p.id), pid] })));
  return (
    <div className="stack">
      <Sub title={g.title} go={go} />
      {g.done_looks_like && <section className="card pad"><span className="eyebrow">Done looks like</span><p style={{ margin: "6px 0 0" }}>{g.done_looks_like}</p></section>}

      <section className="stack">
        <span className="eyebrow">Who's in it</span>
        <div className="row">{v.people.length === 0 ? <span className="muted small">No one added to People yet.</span> : v.people.map((p: Ref) => { const on = g.people.some((x) => x.id === p.id); return <button key={p.id} className="status" aria-pressed={on} style={on ? { background: "#fff", color: "#0d101c" } : undefined} onClick={() => togglePerson(p.id)}>{p.name}</button>; })}</div>
      </section>

      <section className="stack">
        <span className="eyebrow">The path · one step at a time</span>
        <ol className="steps">
          {g.steps.map((st, i) => (
            <li key={st.id} className={st.done_at ? "done" : st.id === g.current_step ? "current" : "later"}>
              <span className="num">{st.done_at ? "✓" : i + 1}</span>
              <span className="grow">{st.title}<span className="small block">{st.done_at ? `Done ${when(st.done_at)}` : st.id === g.current_step ? "You are here" : "Not yet"}</span></span>
              {st.id === g.current_step && <button className="btn" onClick={() => act(() => s.call(`/api/people/steps/${st.id}/done`, { method: "POST" }))}>Done</button>}
            </li>
          ))}
        </ol>
        <form className="row" onSubmit={(e) => { e.preventDefault(); act(async () => { await s.call(`/api/people/goals/${id}/steps`, json("POST", { title: step })); setStep(""); }); }}>
          <label htmlFor="sp" className="sr">New step</label>
          <input id="sp" className="grow plain-input" type="text" placeholder="Add a step to the end" value={step} onChange={(e) => setStep(e.target.value)} />
          <button className="btn" type="submit" disabled={!step.trim()}>Add</button>
        </form>
      </section>

      <GoalCard s={s} g={g} onChanged={load} onError={onError} label="The outcome" />

      {v.people.length > 0 && <NoteForm s={s} stt={stt} people={g.people.length ? g.people : v.people} goalId={id} outcomes={["hook", "close", "flake", "nothing"]} onSaved={load} onError={onError} />}
      <section className="card pad stack"><span className="eyebrow">What's happened so far</span><Log log={v.log} /></section>

      {v.library.length > 0 && (
        <section className="card pad stack">
          <span className="eyebrow">From the library</span>
          <ul className="list">{v.library.map((x: any) => <li key={x.id}><button className="linkish grow" onClick={() => s.call(`/api/people/library/${x.id}`).then(setPassage).catch((e) => onError(e.message))}>{x.heading}<span className="muted small"> · {x.doc}</span></button></li>)}</ul>
          {passage && <div className="passage"><strong>{passage.heading}</strong><p>{passage.body}</p><button className="btn ghost" onClick={() => setPassage(null)}>Close</button></div>}
        </section>
      )}

      <div className="row">
        <button className="btn" onClick={() => s.call<{ id: number }>("/api/people/readings", json("POST", { goal_id: id })).then((r) => go({ at: "reading", id: r.id, from: here })).catch((e) => onError(e.message))}>Guide me on this</button>
        <button className="btn ghost" onClick={() => act(async () => { await s.call(`/api/people/goals/${id}`, json("PATCH", { status: "done" })); go({ at: "home" }); })}>Mark it achieved</button>
      </div>
    </div>
  );
}

/* ---------- A reading ---------- */
function ReadingScreen({ s, go, onError, id, from }: In & { id: number; from: Screen }) {
  const [r, load] = useLoad<any>(s, `/api/people/readings/${id}`, onError);
  const [passage, setPassage] = useState<any>(null);
  if (!r) return <p className="muted">Loading…</p>;
  const b = r.body;
  const missing = b.readings.filter((x: any) => !x.grade).length;
  const act = async (body: unknown) => { try { await s.call(`/api/people/readings/${id}`, json("PATCH", body)); await load(); } catch (e) { onError((e as Error).message); } };
  const Block = ({ n, title, children, hot }: { n: number; title: string; children: ReactNode; hot?: boolean }) => <section className={hot ? "card pad stack hot" : "card pad stack"}><span className={hot ? "eyebrow accent" : "eyebrow"}>{n} · {title}</span>{children}</section>;
  return (
    <div className="stack">
      <Sub title="Reading" go={go} to={from} />
      <p className="muted small" style={{ margin: 0 }}>{r.model} · {when(r.ts)}{r.accepted ? " · accepted" : ""}</p>
      {b.no_quotes && <p className="accent small" style={{ margin: 0 }}>The notes had no direct quotes, so this rests on your summary. Add what they actually said and ask again.</p>}
      <Block n={1} title="What happened"><ol className="plain-ol">{(b.what_happened ?? []).map((x: string, i: number) => <li key={i}>{x}</li>)}</ol></Block>
      <Block n={2} title="Readings">
        {b.readings.map((x: any, i: number) => (
          <div key={i} className={x.grade ? "stack" : "stack ungraded"}>
            <span>{x.text} {x.grade && <code className="electro">[{x.grade}]</code>}</span>
            {x.wrong_if && <span className="muted small">Wrong if: {x.wrong_if}</span>}
            {!x.grade && (
              <>
                <span className="accent small">Needs a grade before you can accept this reading</span>
                <div className="grades">{r.grades.map((gr: string) => <button key={gr} aria-label={`Grade: ${GRADE_NAMES[gr]}`} title={GRADE_NAMES[gr]} onClick={() => act({ grade: { index: i, value: gr } })}>{gr}</button>)}</div>
              </>
            )}
          </div>
        ))}
      </Block>
      <Block n={3} title="What would change my mind"><p style={{ margin: 0 }}>{b.change_my_mind}</p></Block>
      <Block n={4} title="Brakes check"><p style={{ margin: 0 }}>{b.brakes}</p></Block>
      <Block n={5} title="One next move" hot><span className="next-title" style={{ fontSize: 28 }}>{b.next_action?.what}{b.next_action?.when ? ` · ${day(b.next_action.when)}` : ""}</span></Block>
      <Block n={6} title="Words · quotable, not a script">
        {b.words ? (
          <>
            <p style={{ margin: 0 }}>“{b.words.text}”</p>
            <button className="linkish" onClick={() => s.call(`/api/people/library/${b.words.source}`).then(setPassage).catch((e) => onError(e.message))}>See where this comes from</button>
            {passage && <div className="passage"><strong>{passage.doc} › {passage.heading}</strong><p>{passage.body}</p></div>}
          </>
        ) : <p className="muted" style={{ margin: 0 }}>The library doesn't cover this.</p>}
      </Block>
      {!r.accepted && <div className="row"><button className="btn" disabled={missing > 0} onClick={() => act({ accept: true })}>{missing ? `Accept · ${missing} grade${missing === 1 ? "" : "s"} missing` : "Accept and set as the next move"}</button></div>}
      <section className="card pad stack">
        <span className="eyebrow electro">What went into this</span>
        <ul className="plain-ol muted small">
          <li>{r.manifest.notes} note{r.manifest.notes === 1 ? "" : "s"}{r.manifest.person ? ` about ${r.manifest.person}` : ""}</li>
          <li>{r.manifest.open_questions} open question{r.manifest.open_questions === 1 ? "" : "s"}</li>
          <li>{r.manifest.passages.length ? `Library: ${r.manifest.passages.map((x: any) => x.title).join("; ")}` : "No library passages"}</li>
          <li>No one else</li>
        </ul>
        <span className="muted small">Answered by People's model only. Never sent to Claude or ChatGPT.</span>
      </section>
    </div>
  );
}

/* ---------- Library ---------- */
function LibraryScreen({ s, go, onError }: In) {
  const [lib, load] = useLoad<{ docs: Array<{ doc: string; passages: number }> }>(s, "/api/people/library", onError);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const [passage, setPassage] = useState<any>(null);
  const [note, setNote] = useState<string | null>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const data = new FormData();
    [...files].forEach((f) => data.append("file", f));
    try { const r = await s.call<{ files: number; passages: number }>("/api/people/library", { method: "POST", body: data }); setNote(`Read ${r.files} file${r.files === 1 ? "" : "s"} into ${r.passages} passages.`); await load(); } catch (e) { onError((e as Error).message); }
  };
  return (
    <div className="stack">
      <Sub title="Library" go={go} to={{ at: "records" }} />
      <p className="muted small" style={{ margin: 0 }}>Your research notes. Readings quote from these and link back to the passage. Uploading a file again replaces the old copy.</p>
      <div className="row">
        <label className="btn as-link upload">Add markdown or text files<input className="sr" type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => { upload(e.target.files); e.target.value = ""; }} /></label>
      </div>
      {note && <p className="small electro" role="status">{note}</p>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); s.call<{ results: any[] }>(`/api/people/library?q=${encodeURIComponent(q)}`).then((r) => setResults(r.results)).catch((er) => onError(er.message)); }}>
        <label htmlFor="lq" className="sr">Search the library</label>
        <input id="lq" className="grow plain-input" type="search" placeholder="Search the library" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" type="submit" disabled={!q.trim()}>Search</button>
      </form>
      {results && (results.length === 0 ? <p className="muted">The library doesn't cover that.</p> : <ul className="list">{results.map((x) => <li key={x.id}><button className="linkish grow" onClick={() => s.call(`/api/people/library/${x.id}`).then(setPassage).catch((e) => onError(e.message))}>{x.heading}<span className="muted small"> · {x.doc}</span></button></li>)}</ul>)}
      {passage && <div className="passage"><strong>{passage.doc} › {passage.heading}</strong><p>{passage.body}</p><button className="btn ghost" onClick={() => setPassage(null)}>Close</button></div>}
      <section className="card pad">
        <span className="eyebrow">Files</span>
        {lib?.docs.length === 0 && <p className="muted small">Nothing yet.</p>}
        <ul className="list">{lib?.docs.map((x) => <li key={x.doc}><span className="grow">{x.doc}<span className="muted small"> · {x.passages} passages</span></span><button className="btn ghost" aria-label={`Remove ${x.doc}`} onClick={() => s.call(`/api/people/library?doc=${encodeURIComponent(x.doc)}`, { method: "DELETE" }).then(load).catch((e) => onError(e.message))}>✕</button></li>)}</ul>
      </section>
    </div>
  );
}

/* ---------- Handed over from Hermes ---------- */
function InboxScreen({ s, go, onError }: In) {
  const [data, load] = useLoad<{ items: Array<{ id: number; ts: string; source: string; text: string; file_id: number | null }>; people: Ref[] }>(s, "/api/people/inbox", onError);
  const [who, setWho] = useState<Record<number, string>>({});
  const [fresh, setFresh] = useState<Record<number, string>>({});
  if (!data) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  return (
    <div className="stack">
      <Sub title="Handed over" go={go} />
      {data.items.length === 0 && <p className="muted">Nothing waiting.</p>}
      
      {data.items.map((i) => (
        <section key={i.id} className="card pad stack">
          <span className="eyebrow electro">{i.source} · {when(i.ts)}</span>
          <p className="handed">{i.text}</p>
          {i.file_id && <a className="small" href={`/api/people/files/${i.file_id}`} target="_blank" rel="noreferrer">See the attachment</a>}
          <div className="row">
            <select className="inline" aria-label="Who is this about" value={who[i.id] ?? ""} onChange={(e) => setWho({ ...who, [i.id]: e.target.value })}><option value="">Who is this about?</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="new">Someone new…</option></select>
            {who[i.id] === "new" && <input className="plain-input" type="text" aria-label="New person's name" placeholder="Their name" value={fresh[i.id] ?? ""} onChange={(e) => setFresh({ ...fresh, [i.id]: e.target.value })} />}
            <button className="btn" disabled={!who[i.id] || (who[i.id] === "new" && !fresh[i.id]?.trim())} onClick={() => act(async () => {
              const pid = who[i.id] === "new" ? (await s.call<Ref>("/api/people/persons", json("POST", { name: fresh[i.id] }))).id : Number(who[i.id]);
              await s.call("/api/people/interactions", json("POST", { person_id: pid, text: i.text, inbox_id: i.id }));
            })}>File it</button>
            <button className="btn ghost" onClick={() => act(() => s.call(`/api/people/inbox/${i.id}/skip`, { method: "POST" }))}>Skip</button>
          </div>
        </section>
      ))}
    </div>
  );
}
