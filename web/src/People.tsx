import { useCallback, useEffect, useState, type ReactNode } from "react";
import { json } from "./api";
import { LockGate, type Session } from "./Lock";
import { MicButton, ScreenHead, useDictation } from "./ui";

type Props = { onBack: () => void; onError: (m: string) => void; stt?: boolean };
type Go = (screen: Screen) => void;
type Screen = { at: "home" } | { at: "person"; id: number } | { at: "scenario"; id: number } | { at: "reading"; id: number; from: Screen } | { at: "tell" } | { at: "library" } | { at: "inbox" };
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
    case "tell": return <TellScreen {...p} />;
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

/* ---------- Home ---------- */
function Home({ s, go, onError, onBack }: In & { onBack: () => void }) {
  const [h, load] = useLoad<any>(s, "/api/people/home", onError);
  const [adding, setAdding] = useState<null | "relationship" | "scenario">(null);
  const [f, setF] = useState({ name: "", how_met: "", building_toward: "", title: "", done_looks_like: "", steps: "", people: [] as number[] });
  if (!h) return <p className="muted">Loading…</p>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (adding === "relationship") { const p = await s.call<Ref>("/api/people/persons", json("POST", f)); go({ at: "person", id: p.id }); }
      else { const g = await s.call<Goal>("/api/people/goals", json("POST", { kind: "scenario", title: f.title, done_looks_like: f.done_looks_like, people: f.people, steps: f.steps.split("\n") })); go({ at: "scenario", id: g.id }); }
    } catch (err) { onError((err as Error).message); }
  };
  const noMove = [...h.relationships, ...h.scenarios].filter((g: Goal) => !g.next_action);
  return (
    <div className="stack">
      <ScreenHead title="People" onBack={onBack} right={<button className="btn" onClick={s.lock}>Lock now</button>} />

      {h.next ? (
        <button className="card pad hot trip-card" onClick={() => go(h.next.kind === "scenario" ? { at: "scenario", id: h.next.goal_id } : { at: "person", id: h.next.person_id })}>
          <span className="eyebrow accent">Next move</span>
          <span className="next-title" style={{ fontSize: 30 }}>{h.next.action} · {day(h.next.due)}</span>
          <span className="muted small">For: {h.next.for}</span>
        </button>
      ) : <section className="card pad"><span className="eyebrow accent">Next move</span><p className="muted">Nothing dated yet. Give a relationship or a scenario a next move with a date.</p></section>}

      <section className="stack">
        <div className="row"><span className="eyebrow grow">Relationships I'm building</span><button className="btn ghost" onClick={() => setAdding(adding === "relationship" ? null : "relationship")}>+ Add</button></div>
        {h.relationships.length === 0 && <p className="muted small">No one yet. Add a person and what you want it to become.</p>}
        <div className="grid-2">
          {h.relationships.map((g: Goal) => (
            <button key={g.id} className="card pad trip-card" onClick={() => go({ at: "person", id: g.person_id! })}>
              <span className="row"><span className="module-name grow">{g.people[0]?.name}</span><span className="muted small">{quiet(g.days_quiet)}</span></span>
              <span className="muted small">Building toward: <span style={{ color: "#fff" }}>{g.title}</span></span>
              <span className={g.next_action ? "small accent" : "small muted"}>{g.next_action ? `Next: ${g.next_action}${g.next_due ? ` · ${day(g.next_due)}` : ""}` : "Next: nothing set"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="stack">
        <div className="row"><span className="eyebrow grow">Scenarios I'm working toward</span><button className="btn ghost" onClick={() => setAdding(adding === "scenario" ? null : "scenario")}>+ Add</button></div>
        {h.scenarios.length === 0 && <p className="muted small">None yet. A scenario is an outcome you want, with or without a named person.</p>}
        <div className="grid-2">
          {h.scenarios.map((g: Goal) => (
            <button key={g.id} className="card pad trip-card" onClick={() => go({ at: "scenario", id: g.id })}>
              <span className="module-name">{g.title}</span>
              <span className="muted small">With: {g.people.length ? g.people.map((x) => x.name).join(", ") : "no one named yet"}{g.steps.length ? ` · step ${g.step_number} of ${g.steps.length}` : ""}</span>
              <span className={g.next_action ? "small accent" : "small muted"}>{g.next_action ? `Next: ${g.next_action}${g.next_due ? ` · ${day(g.next_due)}` : ""}` : "Next: nothing set"}</span>
            </button>
          ))}
        </div>
      </section>

      {adding && (
        <form className="card pad form" onSubmit={save}>
          <span className="eyebrow">{adding === "relationship" ? "New relationship" : "New scenario"}</span>
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

      {(h.inbox > 0 || h.stale.length > 0 || noMove.length > 0) && (
        <section className="card pad">
          <span className="eyebrow accent">It needs you</span>
          <ul className="list">
            {h.inbox > 0 && <li><button className="linkish grow" onClick={() => go({ at: "inbox" })}>{h.inbox} item{h.inbox === 1 ? "" : "s"} handed over from Hermes, waiting to be filed</button></li>}
            {noMove.map((g: Goal) => <li key={g.id}><button className="linkish grow" onClick={() => go(g.kind === "scenario" ? { at: "scenario", id: g.id } : { at: "person", id: g.person_id! })}>{g.kind === "scenario" ? g.title : g.people[0]?.name} has no next move</button></li>)}
            {h.stale.map((p: any) => <li key={p.id}><button className="linkish grow" onClick={() => go({ at: "person", id: p.id })}>{p.name}: {p.days} days quiet</button></li>)}
          </ul>
        </section>
      )}

      <div className="row">
        <button className="btn" onClick={() => go({ at: "tell" })}>Tell it</button>
        <button className="btn" onClick={() => go({ at: "library" })}>Library</button>
      </div>
      {!h.has_model && <p className="muted small">The chat and readings are off until you set a model for People in Settings. Everything else works without one.</p>}
      <p className="muted small">Locks itself after {s.idleMinutes} minutes idle.</p>
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
  if (!v) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
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

/* ---------- Tell it ---------- */
function TellScreen({ s, go, onError, stt }: In) {
  const [data, load] = useLoad<{ messages: Array<{ id: number; role: string; text: string }> }>(s, "/api/people/chat", onError);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [did, setDid] = useState<string[]>([]);
  const send = async (value: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try { const r = await s.call<{ did: string[] }>("/api/people/tell", json("POST", { text: value })); setText(""); setDid(r.did); await load(); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };
  const d = useDictation(stt, (t) => send(t), onError);
  return (
    <div className="stack">
      <Sub title="Tell it" go={go} />
      <p className="muted small" style={{ margin: 0 }}>People's own model · never shown to Claude or ChatGPT</p>
      <div className="chat">
        {data?.messages.length === 0 && <p className="muted">Tell it about someone, or what just happened. It files what it can and asks when it's unsure.</p>}
        {data?.messages.map((m) => <div key={m.id} className={m.role === "user" ? "bubble me" : "bubble"}>{m.text}</div>)}
        {busy && <div className="bubble muted">Thinking…</div>}
        {did.length > 0 && <div className="row">{did.map((x, i) => <span key={i} className="status ok">{x}</span>)}</div>}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <label htmlFor="tell" className="sr">Message</label>
        <input id="tell" className="grow plain-input" type="text" autoComplete="off" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : "Type, or tap the mic"} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} />
        {text.trim() && <button className="btn" type="submit" disabled={busy}>Send</button>}
        <MicButton d={d} small />
      </form>
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
      <Sub title="Library" go={go} />
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
  const [data, load] = useLoad<{ items: Array<{ id: number; ts: string; source: string; text: string }>; people: Ref[] }>(s, "/api/people/inbox", onError);
  const [who, setWho] = useState<Record<number, string>>({});
  if (!data) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  return (
    <div className="stack">
      <Sub title="Handed over" go={go} />
      {data.items.length === 0 && <p className="muted">Nothing waiting.</p>}
      {data.people.length === 0 && data.items.length > 0 && <p className="accent small">Add the people these are about first, then come back to file them.</p>}
      {data.items.map((i) => (
        <section key={i.id} className="card pad stack">
          <span className="eyebrow electro">{i.source} · {when(i.ts)}</span>
          <p className="handed">{i.text}</p>
          <div className="row">
            <select className="inline" aria-label="Who is this about" value={who[i.id] ?? ""} onChange={(e) => setWho({ ...who, [i.id]: e.target.value })}><option value="">Who is this about?</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button className="btn" disabled={!who[i.id]} onClick={() => act(() => s.call("/api/people/interactions", json("POST", { person_id: Number(who[i.id]), text: i.text, inbox_id: i.id })))}>File it</button>
            <button className="btn ghost" onClick={() => act(() => s.call(`/api/people/inbox/${i.id}/skip`, { method: "POST" }))}>Skip</button>
          </div>
        </section>
      ))}
    </div>
  );
}
