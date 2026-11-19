import { useCallback, useEffect, useRef, useState } from "react";
import { api, dueLabel, type AreaView, type Config, type Deck, type Settings, type Task } from "./api";

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

function SettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [typeIt, setTypeIt] = useState(false);

  const findModels = async (url: string, key?: string) => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.models({ llm_url: url, ...(key ? { llm_key: key } : {}) });
      setModels(r.ok ? r.models : null);
      setTypeIt(false);
      setMsg({ ok: r.ok, text: r.message });
      // One model on offer: pick it.
      if (r.ok && r.models.length === 1) setForm((f) => ({ ...f, llm_model: r.models[0] }));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    api.settings().then((v) => { setS(v); if (v.llm_url) findModels(v.llm_url); }).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const save = async (thenTest: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      setS(await api.saveSettings(form));
      setForm({});
      onSaved();
      if (thenTest) {
        const r = await api.testModel();
        setMsg({ ok: r.ok, text: r.message });
      } else setMsg({ ok: true, text: "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <section className="card settings"><p className="muted">{msg?.text ?? "Loading settings…"}</p></section>;
  const val = (k: keyof Settings) => form[k] ?? String(s[k] ?? "");
  return (
    <section className="card settings" aria-label="Settings">
      <div className="settings-head">
        <h2 className="module-name">Settings</h2>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>

      <fieldset>
        <legend className="eyebrow">Model that files your quick-adds</legend>
        <p className="muted small">Any OpenAI-style address, such as Hermes on this Umbrel. Leave empty to file by simple rules.</p>
        <div className="fields">
          <label htmlFor="llm_url">Address
            <input id="llm_url" type="url" inputMode="url" placeholder="http://…:8642/v1" value={val("llm_url")} onChange={set("llm_url")} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== s.llm_url) findModels(e.target.value, form.llm_key); }} />
          </label>
          <label htmlFor="llm_key">Key, if it needs one
            <input id="llm_key" type="password" autoComplete="off" placeholder={s.llm_key_set ? "Saved. Type to replace" : "None saved"} value={form.llm_key ?? ""} onChange={set("llm_key")} />
          </label>
          <label htmlFor="llm_model">Model
            {models && !typeIt ? (
              <select id="llm_model" value={val("llm_model")} onChange={set("llm_model")}>
                <option value="">Choose a model…</option>
                {val("llm_model") && !models.includes(val("llm_model")) && <option value={val("llm_model")}>{val("llm_model")}</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input id="llm_model" type="text" autoCapitalize="off" placeholder="Find models, or type the name" value={val("llm_model")} onChange={set("llm_model")} />
            )}
          </label>
        </div>
        <div className="row">
          <button className="btn" type="button" disabled={busy || !val("llm_url").trim()} onClick={() => findModels(val("llm_url"), form.llm_key)}>Find models</button>
          {models && <button className="btn ghost" type="button" onClick={() => setTypeIt(!typeIt)}>{typeIt ? "Pick from the list" : "Type it instead"}</button>}
        </div>
      </fieldset>

      <fieldset>
        <legend className="eyebrow">Speech-to-text for the mic</legend>
        <p className="muted small">A Whisper-style service. The mic stays off until this is set.</p>
        <div className="fields">
          <label htmlFor="stt_url">Address
            <input id="stt_url" type="url" inputMode="url" placeholder="http://…/v1" value={val("stt_url")} onChange={set("stt_url")} />
          </label>
          <label htmlFor="stt_model">Model name
            <input id="stt_model" type="text" autoCapitalize="off" placeholder="whisper-1" value={val("stt_model")} onChange={set("stt_model")} />
          </label>
          <label htmlFor="stt_key">Key
            <input id="stt_key" type="password" autoComplete="off" placeholder={s.stt_key_set ? "Saved. Type to replace" : "None saved"} value={form.stt_key ?? ""} onChange={set("stt_key")} />
          </label>
        </div>
      </fieldset>

      {msg && <p className={msg.ok ? "small electro" : "small accent"} role="status">{msg.text}</p>}
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => save(true)}>{busy ? "Working…" : "Save and test the model"}</button>
        <button className="btn ghost" disabled={busy} onClick={() => save(false)}>Save only</button>
      </div>
    </section>
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
