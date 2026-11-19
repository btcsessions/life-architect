import { useCallback, useEffect, useRef, useState } from "react";
import { api, dueLabel, type AreaView, type Config, type Deck, type Task } from "./api";

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
        <span className="chip">{config?.model ? `Model: ${config.model}` : "Filing by rules · no model set"}</span>
      </header>

      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
          <button className="btn ghost" onClick={load}>Try again</button>
        </div>
      )}

      {deck && (
        <>
          <NextUp deck={deck} onDone={(id) => act(() => api.patch(id, { status: "done" }))} onLater={(id) => act(() => api.patch(id, { snooze: true }))} />

          {deck.addedToday > 0 && (
            <p className="muted small">{deck.addedToday} added today from other apps</p>
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

      <QuickAdd
        stt={Boolean(config?.stt)}
        onError={setError}
        onFiled={async (tasks) => { setFiled(tasks); await load(); }}
      />
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
  onToggle: () => void; onEdit: (id: number | null) => void; act: (fn: () => Promise<unknown>) => void;
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
          {area.locked ? (
            <p className="muted">{area.need > 0 ? "Something due. " : ""}People opens with its own PIN once that phase is built.</p>
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
  if (t.due) parts.push(dueLabel(t.due, today));
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
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micNote, setMicNote] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  const submit = async (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      const { created } = await api.capture(v);
      setText("");
      onFiled(created);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleMic = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    if (!stt) return setMicNote("Voice needs a speech-to-text service on the Umbrel. It isn't set up yet, so type for now.");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      return setMicNote("The browser only allows the microphone over HTTPS. Open the deck through its Tailscale HTTPS address.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setBusy(true);
        try {
          const { text: heard } = await api.transcribe(new Blob(chunks, { type: rec.mimeType }));
          setBusy(false);
          if (heard) await submit(heard);
          else setMicNote("Didn't catch anything. Try again a little closer to the mic.");
        } catch (e) {
          setBusy(false);
          onError((e as Error).message);
        }
      };
      recorder.current = rec;
      rec.start();
      setMicNote(null);
      setRecording(true);
    } catch {
      setMicNote("Microphone access was blocked. Allow it for this site in the browser's settings.");
    }
  };

  return (
    <footer className="quick">
      {micNote && <p className="small quick-note" role="status">{micNote}</p>}
      <form className="quick-bar" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
        <label htmlFor="quick" className="sr">Quick add</label>
        <input
          id="quick"
          type="text"
          autoComplete="off"
          placeholder={recording ? "Listening… tap the mic to stop" : "Add anything: what, when it's due, how long, how important"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || recording}
        />
        {text.trim() && <button className="btn" type="submit" disabled={busy}>{busy ? "Filing…" : "Add"}</button>}
        <button type="button" className={recording ? "mic on" : "mic"} aria-label={recording ? "Stop and file" : "Talk"} aria-pressed={recording} onClick={toggleMic} disabled={busy}>
          <Mic />
        </button>
      </form>
    </footer>
  );
}
