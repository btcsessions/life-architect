import { useCallback, useEffect, useRef, useState } from "react";
import { api, call, json, dueLabel, type AreaView, type Config, type Deck, type Task } from "./api";
import { SettingsPanel } from "./Settings";
import { Travel } from "./Travel";
import { Money } from "./Money";
import { People } from "./People";
import { Inbox } from "./Inbox";

/** Areas that have their own full screen. */
const SCREENS: Record<string, string> = { travel: "Trips", money: "Money", people: "People", inbox: "Inbox" };

const ICONS: Record<string, string> = {
  work: "M4 4h12a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM8.5 7.5v4l3.5-2z",
  travel: "M2 12l16-6-5 11-3-5z",
  family: "M10 17s-6.5-3.8-6.5-8.3A3.6 3.6 0 0110 6.5a3.6 3.6 0 016.5 2.2C16.5 13.2 10 17 10 17z",
  health: "M2 10h3l2-5 4 10 2-5h5",
  inbox: "M4 4h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM2.5 5.5l7.5 6 7.5-6",
  hobbies: "M8.5 15V4l8-2v11M8.5 15a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM16.5 13a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z",
  build: "M11 2L4 11h5l-1 7 7-9h-5z",
  money: "M6 9V6.5a4 4 0 018 0V9M5 9h10a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6a1 1 0 011-1z",
  lock: "M6 9V6.5a4 4 0 018 0V9M5 9h10a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6a1 1 0 011-1z",
};

function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d={d} />
    </svg>
  );
}

function Mic({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </svg>
  );
}

export function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [filed, setFiled] = useState<Task[] | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<string>("deck");
  const [added, setAdded] = useState<Array<{ text: string; source: string }> | null>(null);
  const back = () => { setView("deck"); load(); };
  // Inside a module an error is about the last action, so it clears itself.
  useEffect(() => { if (!error || view === "deck") return; const t = setTimeout(() => setError(null), 7000); return () => clearTimeout(t); }, [error, view]);

  const load = useCallback(async () => {
    try {
      setDeck(await api.deck());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    api.config().then(setConfig).catch(() => {});
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const dateLine = new Date().toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="wordmark">Life <span className="accent">Architect</span></span>
          <span className="eyebrow">{dateLine}</span>
        </div>
        <button className="chip" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}>
          {config?.model ? `Model: ${config.model}` : "No model set"} · Settings
        </button>
      </header>

      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} onSaved={() => api.config().then(setConfig).catch(() => {})} />
      )}

      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
          {view === "deck" ? <button className="btn ghost" onClick={load}>Try again</button> : <button className="btn ghost" onClick={() => setError(null)}>Dismiss</button>}
        </div>
      )}

      {view === "travel" && <Travel onBack={back} onError={setError} />}
      {view === "money" && <Money onBack={back} onError={setError} />}
      {view === "people" && <People onBack={back} onError={setError} stt={Boolean(config?.stt)} />}
      {view === "inbox" && <Inbox onBack={back} onError={setError} stt={Boolean(config?.stt)} />}

      {view === "deck" && deck && (
        <>
          <NextUp deck={deck} onDone={(id) => act(() => api.patch(id, { status: "done" }))} onLater={(id) => act(() => api.patch(id, { snooze: true }))} />

          {deck.addedToday > 0 && (
            <div>
              <button className="btn ghost" aria-expanded={Boolean(added)} onClick={async () => setAdded(added ? null : (await call<{ items: Array<{ text: string; source: string }> }>("/api/added")).items)}>
                {deck.addedToday} added today from other apps · {added ? "hide" : "review"}
              </button>
              {added && (
                <ul className="added">
                  {added.map((a, i) => <li key={i}><span className="eyebrow electro">{a.source}</span><span>{a.text}</span></li>)}
                </ul>
              )}
            </div>
          )}

          <main className="modules">
            {deck.areas.map((a) => (
              <Module
                key={a.id}
                area={a}
                today={deck.today}
                areas={deck.areas}
                open={open === a.id}
                editing={editing}
                onToggle={() => { setOpen(open === a.id ? null : a.id); setEditing(null); }}
                onEdit={setEditing}
                onOpenScreen={SCREENS[a.id] ? () => setView(a.id) : undefined}
                act={act}
              />
            ))}
          </main>
        </>
      )}

      {!deck && !error && <p className="muted">Loading your deck…</p>}

      {filed && (
        <div className="filed" role="status">
          <div className="filed-head">
            <span className="eyebrow accent">Filed</span>
            <button className="btn ghost" onClick={() => setFiled(null)}>Close</button>
          </div>
          <ul>
            {filed.map((t) => (
              <li key={t.id}>
                <span className="eyebrow electro">{t.area_name}{t.delegate ? ` · ${t.delegate}` : ""}</span>
                <span>{t.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === "deck" && <QuickAdd
        stt={Boolean(config?.stt)}
        onError={setError}
        onFiled={async (tasks) => { setFiled(tasks); await load(); }}
      />}
    </div>
  );
}

function NextUp({ deck, onDone, onLater }: { deck: Deck; onDone: (id: number) => void; onLater: (id: number) => void }) {
  const [first, ...rest] = deck.next;
  if (!first) {
    return (
      <section className="card next">
        <div className="next-main">
          <span className="eyebrow accent">Next up</span>
          <h1 className="next-title">Nothing queued</h1>
          <p className="muted">Add something below. Say how important it is, when it's due and how long it takes, and it gets ranked here.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="card next">
      <div className="next-main">
        <span className="eyebrow accent">Next up</span>
        <h1 className="next-title">{first.title}</h1>
        {first.why.length > 0 && (
          <div className="tags">
            {first.why.map((w, i) => <span key={w} className={i === 0 && w.startsWith("High") ? "tag hot" : "tag"}>{w}</span>)}
          </div>
        )}
        <div className="row">
          {!first.locked && <button className="btn" onClick={() => onDone(first.id)}>Done, what's next?</button>}
          <button className="btn ghost" onClick={() => onLater(first.id)}>Not today</button>
        </div>
      </div>
      {rest.length > 0 && (
        <div className="next-then">
          <span className="eyebrow">Then</span>
          <ol>
            {rest.map((n, i) => (
              <li key={n.id}>
                <span className="num">{i + 2}</span>
                <span className="then-text"><strong>{n.title}</strong><span className="muted small">{n.why.join(" · ")}</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function Module(props: {
  area: AreaView; today: string; areas: AreaView[]; open: boolean; editing: number | null;
  onToggle: () => void; onEdit: (id: number | null) => void; onOpenScreen?: () => void; act: (fn: () => Promise<unknown>) => void;
}) {
  const { area, today, open, editing, onToggle, onEdit, act } = props;
  return (
    <section className={open ? "card module open" : "card module"}>
      <button className="module-head" aria-expanded={open} onClick={onToggle}>
        <span className="module-icon"><Icon d={area.locked ? ICONS.lock : ICONS[area.id] ?? ICONS.work} /></span>
        <span className="module-name">{area.name}</span>
        {area.need > 0 && <span className="badge" aria-label={`${area.need} need you`}>{area.need}</span>}
      </button>
      {open && (
        <div className="module-body">
          {props.onOpenScreen && <button className="btn open-screen" onClick={props.onOpenScreen}>Open {SCREENS[area.id]}</button>}
          {area.id === "inbox" && (area.mail ?? 0) > 0 && <p className="accent small">{area.mail} email{area.mail === 1 ? "" : "s"} waiting on you.</p>}
          {area.id === "build" && <Noticed act={act} />}
          {area.locked ? (
            <p className="muted">{area.need > 0 ? "Something due. " : ""}Details are behind the People PIN.</p>
          ) : area.items.length === 0 ? (
            <p className="muted">Nothing here yet. Add to it from the bar below.</p>
          ) : (
            <ul className="tasks">
              {area.items.map((t) => (
                <li key={t.id}>
                  <div className="task">
                    <input
                      type="checkbox"
                      aria-label={`Mark "${t.title}" done`}
                      onChange={() => act(() => api.patch(t.id, { status: "done" }))}
                    />
                    <button className="task-main" aria-expanded={editing === t.id} onClick={() => onEdit(editing === t.id ? null : t.id)}>
                      <span className={t.needs_you ? "dot" : "ring"} aria-hidden="true" />
                      <span className="task-text">
                        <span>{t.title}</span>
                        <span className="muted small">{taskMeta(t, today)}</span>
                      </span>
                    </button>
                  </div>
                  {editing === t.id && <Editor task={t} areas={props.areas} act={act} onClose={() => onEdit(null)} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function taskMeta(t: Task, today: string): string {
  const parts: string[] = [];
  if (t.delegate) parts.push(`With ${t.delegate}`);
  if (t.due) parts.push(dueLabel(t.due, today) + (t.due_time ? ` at ${t.due_time}` : ""));
  if (t.minutes) parts.push(t.minutes < 60 ? `${t.minutes} min` : `${+(t.minutes / 60).toFixed(1)} hr`);
  if (t.snoozed_until && t.snoozed_until > today) parts.push("Not today");
  return parts.join(" · ");
}

function Editor({ task, areas, act, onClose }: { task: Task; areas: AreaView[]; act: (fn: () => Promise<unknown>) => void; onClose: () => void }) {
  const save = (body: Record<string, unknown>) => act(() => api.patch(task.id, body));
  const id = `t${task.id}`;
  return (
    <div className="editor">
      <fieldset>
        <legend className="eyebrow">Importance</legend>
        <div className="seg">
          {[["Low", 1], ["Medium", 2], ["High", 3]].map(([label, v]) => (
            <button key={v} aria-pressed={task.importance === v} onClick={() => save({ importance: v })}>{label}</button>
          ))}
        </div>
      </fieldset>
      <div className="fields">
        <label htmlFor={`${id}-due`}>Due
          <input id={`${id}-due`} type="date" defaultValue={task.due ?? ""} onChange={(e) => save({ due: e.target.value || null })} />
        </label>
        <label htmlFor={`${id}-time`}>Time
          <input id={`${id}-time`} type="time" defaultValue={task.due_time ?? ""} onChange={(e) => save({ due_time: e.target.value || null })} />
        </label>
        <label htmlFor={`${id}-min`}>Minutes
          <input id={`${id}-min`} type="number" min="1" inputMode="numeric" defaultValue={task.minutes ?? ""}
            onBlur={(e) => save({ minutes: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label htmlFor={`${id}-who`}>Handed to
          <input id={`${id}-who`} type="text" placeholder="No one" defaultValue={task.delegate ?? ""}
            onBlur={(e) => save({ delegate: e.target.value || null })} />
        </label>
        <label htmlFor={`${id}-area`}>Area
          <select id={`${id}-area`} defaultValue={task.area_id} onChange={(e) => save({ area_id: e.target.value })}>
            {areas.filter((a) => !a.locked || a.id === task.area_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
      {task.note && (
        <p className="small muted note">
          {/^https?:\/\//.test(task.note) ? <a href={task.note} target="_blank" rel="noreferrer">{task.note}</a> : task.note}
        </p>
      )}
      <div className="row">
        <button className="btn ghost" onClick={onClose}>Close</button>
        <button className="btn ghost danger" onClick={() => act(() => api.remove(task.id))}>Delete</button>
      </div>
    </div>
  );
}

function QuickAdd({ stt, onFiled, onError }: { stt: boolean; onFiled: (t: Task[]) => void; onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "hearing" | "filing">(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micNote, setMicNote] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const submit = async (value: string) => {
    const v = value.trim();
    if (!v) return;
    setBusy("filing");
    try {
      const { created } = await api.capture(v);
      setText("");
      onFiled(created);
    } catch (e) {
      // Keep what was said so it isn't lost if filing fails.
      setText(v);
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Audio in, filed tasks out: no step in between.
  const hear = async (audio: Blob, name?: string) => {
    setBusy("hearing");
    try {
      const { text: heard } = await api.transcribe(audio, name);
      if (heard) await submit(heard);
      else setMicNote("Didn't catch anything. Try again a little closer to the mic.");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleMic = async () => {
    if (recording) return recorder.current?.stop();
    setMicNote(null);
    if (!stt) return setMicNote("Voice needs a speech-to-text service on the Umbrel. It isn't set up yet, so type for now.");
    // Browsers only allow live recording over HTTPS. Without it, hand off to the device's own recorder.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
      return fileInput.current?.click();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = rec.mimeType || "audio/webm";
        hear(new Blob(chunks, { type }), /mp4|aac/.test(type) ? "note.m4a" : /ogg/.test(type) ? "note.ogg" : "note.webm");
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMicNote("Microphone access was blocked. Allow it for this site in the browser's settings.");
    }
  };

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const placeholder = recording ? `Listening… ${clock} · tap the mic to stop and file`
    : busy === "hearing" ? "Writing down what you said…"
    : busy === "filing" ? "Filing…"
    : "Add anything: what, when it's due, how long, how important";

  return (
    <footer className="quick">
      {micNote && <p className="small quick-note" role="status">{micNote}</p>}
      <form className="quick-bar" onSubmit={(e) => { e.preventDefault(); if (!busy) submit(text); }}>
        <label htmlFor="quick" className="sr">Quick add</label>
        <input
          id="quick"
          type="text"
          autoComplete="off"
          placeholder={placeholder}
          value={recording || busy === "hearing" ? "" : text}
          onChange={(e) => setText(e.target.value)}
          disabled={Boolean(busy) || recording}
        />
        {text.trim() && !recording && <button className="btn" type="submit" disabled={Boolean(busy)}>{busy ? "Filing…" : "Add"}</button>}
        <input
          ref={fileInput}
          className="sr"
          type="file"
          accept="audio/*"
          capture
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) hear(f, f.name);
          }}
        />
        <button type="button" className={recording ? "mic on" : "mic"} aria-label={recording ? "Stop and file" : "Talk"} aria-pressed={recording} onClick={toggleMic} disabled={Boolean(busy)}>
          <Mic />
        </button>
      </form>
    </footer>
  );
}

/** Patterns the app has spotted. A yes adds a Build task; a no makes it go away for good. */
function Noticed({ act }: { act: (fn: () => Promise<unknown>) => void }) {
  const [list, setList] = useState<Array<{ key: string; text: string }>>([]);
  const load = useCallback(() => call<{ suggestions: Array<{ key: string; text: string }> }>("/api/noticed").then((r) => setList(r.suggestions)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (list.length === 0) return <p className="muted small">Noticed: nothing yet. When you repeat something often enough, it'll be suggested here.</p>;
  const answer = (key: string, a: "yes" | "no") => { setList(list.filter((x) => x.key !== key)); act(() => call("/api/noticed", json("POST", { key, answer: a }))); };
  return (
    <div className="noticed">
      <span className="eyebrow electro">Noticed</span>
      {list.map((x) => (
        <div key={x.key} className="noticed-item">
          <span className="grow">{x.text}</span>
          <button className="btn" onClick={() => answer(x.key, "yes")}>Add to Build</button>
          <button className="btn ghost" onClick={() => answer(x.key, "no")}>No</button>
        </div>
      ))}
    </div>
  );
}
