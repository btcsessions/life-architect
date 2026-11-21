import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { call, json } from "./api";
import { MicButton, ScreenHead, useDictation } from "./ui";

type Props = { onBack: () => void; onError: (m: string) => void; stt?: boolean };
type Screen = { at: "home" } | { at: "tutorial"; id: number } | { at: "bitcast"; id?: number } | { at: "filed" };
interface Brief { id: number; title: string; stage: string; stage_number: number; source: string; has_outline: boolean; has_notes: boolean; links: number; running: string | null; filed_at: string | null }
interface Home { stages: Array<{ id: string; name: string }>; in_motion: Brief[]; up_next: Brief[]; bitcast: { day: string; has_file: boolean; takes: number; running: boolean } | null; filed: number; has_model: boolean }
interface Job { status: "working" | "done" | "failed"; reply: string | null; created_at: string }
interface Full extends Brief { notes: string | null; outline: string | null; outline_from: string | null; outline_url: string | null; video_id: string | null; folder: string | null; next_stage: { id: string; name: string } | null; stages: Array<{ id: string; name: string; state: string }>; link_list: Array<{ id: number; label: string; url: string }>; log: Array<{ ts: string; text: string }>; jobs: { line_edit: Job | null; youtube_prep: Job | null; check: Job | null }; has_model: boolean }
interface Episode { id: number; day: string; file: { name: string; size: number } | null; takes: Array<{ text: string; ts: string; asked: string | null }>; report: string | null; job: { status: string; reply: string | null } | null; has_model: boolean }

const when = (iso: string) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
const NEXT_WORD: Record<string, string> = { idea: "Idea", outline: "Outline in progress", record: "Ready to record", line_edit: "Recorded. Next: line edit", youtube_prep: "Edited. Next: YouTube prep", live: "Live" };

export function Work({ onBack, onError, stt }: Props) {
  const [screen, setScreen] = useState<Screen>({ at: "home" });
  const p = { go: setScreen, onError, stt: Boolean(stt) };
  if (screen.at === "tutorial") return <Tutorial {...p} id={screen.id} />;
  if (screen.at === "bitcast") return <Bitcast {...p} id={screen.id} />;
  if (screen.at === "filed") return <Filed {...p} />;
  return <HomeScreen {...p} onBack={onBack} />;
}
type In = { go: (s: Screen) => void; onError: (m: string) => void; stt: boolean };

const Bars = ({ n, total = 6 }: { n: number; total?: number }) => (
  <span className="bars" role="img" aria-label={`Stage ${n} of ${total}`}>{Array.from({ length: total }, (_, i) => <span key={i} className={i + 1 < n ? "done" : i + 1 === n ? "now" : ""} />)}</span>
);
const Sub = ({ title, eyebrow, go, right }: { title: ReactNode; eyebrow?: string; go: (s: Screen) => void; right?: ReactNode }) => (
  <div className="screen-head"><button className="btn ghost back" onClick={() => go({ at: "home" })}>‹ Work</button><div className="screen-title">{eyebrow && <span className="eyebrow">{eyebrow}</span>}{typeof title === "string" ? <h1>{title}</h1> : title}</div><div className="screen-right">{right}</div></div>
);
const docName = (url: string) => (/docs\.google\.com\/document/.test(url) ? "Google Doc" : /drive\.google\.com/.test(url) ? "Drive file" : new URL(url).hostname);

/* ---------- Work home ---------- */
function HomeScreen({ go, onError, onBack, stt }: In & { onBack: () => void }) {
  const [h, setH] = useState<Home | null>(null);
  const [adding, setAdding] = useState<null | "one" | "list">(null);
  const [title, setTitle] = useState("");
  const [list, setList] = useState("");
  const [underway, setUnderway] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [doomed, setDoomed] = useState<number | null>(null);
  const d = useDictation(stt, (said) => setUnderway((x) => (x ? `${x} ${said}` : said)), onError);
  const [all, setAll] = useState(false);
  const [tasks, setTasks] = useState<Array<{ id: number; title: string }> | null>(null);
  const drag = useRef<number | null>(null);
  const load = useCallback(() => call<Home>("/api/work").then(setH).catch((e) => onError(e.message)), [onError]);
  useEffect(() => { load(); }, [load]);
  if (!h) return <p className="muted">Loading…</p>;

  const reorder = async (ids: number[]) => {
    setH({ ...h, up_next: ids.map((id) => h.up_next.find((t) => t.id === id)!) });
    try { await call("/api/work/tutorials/order", json("POST", { ids })); } catch (e) { onError((e as Error).message); load(); }
  };
  const move = (id: number, to: number) => {
    const ids = h.up_next.map((t) => t.id), from = ids.indexOf(id);
    if (to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    reorder(ids);
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await call<{ added: number; tutorial: Brief; problem: string | null }>("/api/work/tutorials", json("POST", adding === "list" ? { list, source: "a pasted list" } : { title, underway: underway?.trim() || undefined }));
      setTitle(""); setList(""); setUnderway(null); setAdding(null);
      if (r.problem) onError(r.problem);
      if (adding === "one") go({ at: "tutorial", id: r.tutorial.id }); else load();
    } catch (err) { onError((err as Error).message); }
  };
  const rename = async (t: Brief, to: string) => {
    if (!to.trim() || to.trim() === t.title) return;
    try { await call(`/api/work/tutorials/${t.id}`, json("PATCH", { title: to })); load(); } catch (e) { onError((e as Error).message); load(); }
  };
  const remove = async (id: number) => {
    setDoomed(null);
    try { await call(`/api/work/tutorials/${id}`, { method: "DELETE" }); load(); } catch (e) { onError((e as Error).message); }
  };
  const shown = all || editing ? h.up_next : h.up_next.slice(0, 5);
  const firstHot = h.in_motion[0]?.id;

  return (
    <div className="stack work">
      <ScreenHead title="Work" onBack={onBack} />

      <section className="stack">
        <span className="eyebrow accent">In motion</span>
        {h.in_motion.length === 0 && !h.bitcast?.has_file && <p className="muted small">Nothing in production. Open an idea below and give it an outline to start it moving.</p>}
        {h.in_motion.map((t) => (
          <button key={t.id} className={t.id === firstHot ? "card pad work-card hot" : "card pad work-card"} onClick={() => go({ at: "tutorial", id: t.id })}>
            <span className="row"><span className="work-title grow">{t.title}</span><span className="muted small">Tutorial</span></span>
            <Bars n={t.stage_number} />
            <span className="row"><span className="muted grow">{t.running ? "Hermes is working on it…" : NEXT_WORD[t.stage]}</span><span className="status">Open</span></span>
          </button>
        ))}
        <button className="card pad work-card" onClick={() => go({ at: "bitcast" })}>
          <span className="row"><span className="work-title grow">Bitcast, this week</span><span className="muted small">Podcast</span></span>
          <span className="row"><span className="muted grow">{h.bitcast?.running ? "Hermes is working on it…" : h.bitcast?.takes ? `Intro hook ready · take ${h.bitcast.takes}` : h.bitcast?.has_file ? "Rundown added. Prep not run yet" : "Add the rundown to start"}</span><span className="status">Open</span></span>
        </button>
      </section>

      <section className="stack">
        <div className="row"><span className="eyebrow grow">Up next · {h.up_next.length}</span>{editing ? <button className="btn" onClick={() => { setEditing(false); setDoomed(null); }}>Done</button> : <><button className="btn ghost" onClick={() => setAdding(adding === "one" ? null : "one")}>+ Add</button><button className="btn ghost" onClick={() => setAdding(adding === "list" ? null : "list")}>Paste a list</button>{h.up_next.length > 0 && <button className="btn ghost" onClick={() => { setEditing(true); setAdding(null); }}>Edit</button>}</>}</div>
        {adding && (
          <form className="card pad form" onSubmit={add}>
            {adding === "one" ? (
              <>
                <label htmlFor="ti" className="eyebrow">Tutorial</label><input id="ti" className="plain-input" type="text" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
                {underway === null ? <button type="button" className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => setUnderway("")}>Already underway? Say what's done</button> : (
                  <>
                    <label htmlFor="uw" className="eyebrow">What's done so far</label>
                    <div className="row" style={{ alignItems: "flex-start" }}>
                      <textarea id="uw" className="plain grow" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : "e.g. Recorded last week and uploaded as private. Hermes finds the outline, footage and upload."} value={underway} onChange={(e) => setUnderway(e.target.value)} />
                      <MicButton d={d} small />
                    </div>
                  </>
                )}
              </>
            ) : (
              <><label htmlFor="tl" className="eyebrow">One idea per line</label><textarea id="tl" className="plain tall" required value={list} onChange={(e) => setList(e.target.value)} placeholder="Paste from Daniel's doc or anywhere else. Ones already on the list are skipped." /></>
            )}
            <div className="row"><button className="btn" type="submit">{underway?.trim() ? "Add and have Hermes check" : "Add"}</button><button className="btn ghost" type="button" onClick={() => { setAdding(null); setUnderway(null); }}>Cancel</button></div>
          </form>
        )}
        {h.up_next.length === 0 && !adding && <p className="muted small">No ideas yet. Add one, paste a list, or ask Hermes to send its list over.</p>}
        <ol className="ideas">
          {shown.map((t, i) => editing ? (
            <li key={t.id} className="editing">
              <label htmlFor={`rn${t.id}`} className="sr">Rename {t.title}</label>
              <input id={`rn${t.id}`} className="plain-input grow" type="text" defaultValue={t.title} onBlur={(e) => rename(t, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              {doomed === t.id
                ? <><button className="btn danger" onClick={() => remove(t.id)}>Delete</button><button className="btn ghost" onClick={() => setDoomed(null)}>Keep</button></>
                : <button className="btn ghost" aria-label={`Delete ${t.title}`} onClick={() => setDoomed(t.id)}>✕</button>}
            </li>
          ) : (
            <li key={t.id} draggable onDragStart={() => { drag.current = t.id; }} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag.current !== null) move(drag.current, h.up_next.findIndex((x) => x.id === t.id)); drag.current = null; }}>
              <span className="grip" aria-hidden="true"><svg width="14" height="22" viewBox="0 0 14 22" fill="currentColor"><circle cx="3" cy="3" r="2" /><circle cx="11" cy="3" r="2" /><circle cx="3" cy="11" r="2" /><circle cx="11" cy="11" r="2" /><circle cx="3" cy="19" r="2" /><circle cx="11" cy="19" r="2" /></svg></span>
              <span className="idea-n">{i + 1}</span>
              <button className="idea-open grow" onClick={() => go({ at: "tutorial", id: t.id })}>
                <strong>{t.title}</strong>
                <span className="muted small block">{[t.has_outline ? "Outline ready" : "Idea", t.has_notes ? "notes" : null, t.links ? `${t.links} link${t.links === 1 ? "" : "s"}` : null, t.source !== "you" ? `from ${t.source}` : null].filter(Boolean).join(" · ")}</span>
              </button>
              <button className="btn ghost nudge" aria-label={`Move ${t.title} up`} disabled={i === 0} onClick={() => move(t.id, i - 1)}>↑</button>
              <button className="btn ghost nudge" aria-label={`Move ${t.title} down`} disabled={i === h.up_next.length - 1} onClick={() => move(t.id, i + 1)}>↓</button>
            </li>
          ))}
        </ol>
        {editing && <p className="muted small" style={{ margin: 0 }}>Tap a name to rename it. Deleting removes its notes, links and outline for good.</p>}
        {h.up_next.length > 5 && !editing && <button className="more" onClick={() => setAll(!all)}>{all ? "Show the top five" : `Show the other ${h.up_next.length - 5}`}</button>}
      </section>

      <div className="row">
        <button className="btn grow" onClick={() => go({ at: "filed" })}>Filed away{h.filed ? ` · ${h.filed}` : ""}</button>
        <button className="btn grow" aria-expanded={tasks !== null} onClick={() => (tasks ? setTasks(null) : call<{ areas: Array<{ id: string; items: Array<{ id: number; title: string }> }> }>("/api/deck").then((d) => setTasks(d.areas.find((a) => a.id === "work")?.items ?? [])).catch((e) => onError(e.message)))}>Other work tasks</button>
      </div>
      {tasks && (
        <section className="card pad">
          {tasks.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No other work tasks. Add them from the deck.</p> : (
            <ul className="list">{tasks.map((t) => <li key={t.id}><span className="grow">{t.title}</span><button className="btn ghost" onClick={() => call(`/api/tasks/${t.id}`, json("PATCH", { status: "done" })).then(() => setTasks(tasks.filter((x) => x.id !== t.id))).catch((e) => onError(e.message))}>Done</button></li>)}</ul>
          )}
        </section>
      )}
      {!h.has_model && <p className="muted small">The Hermes buttons (line edit, YouTube prep, Bitcast prep) need the deck model set in Settings.</p>}
    </div>
  );
}

/* ---------- One tutorial ---------- */
function Tutorial({ go, onError, stt, id }: In & { id: number }) {
  const [t, setT] = useState<Full | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [outline, setOutline] = useState<string | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [docLink, setDocLink] = useState<string | null>(null);
  const [link, setLink] = useState<{ label: string; url: string } | null>(null);
  const [reply, setReply] = useState("");
  const [details, setDetails] = useState(false);
  const [edit, setEdit] = useState<null | { title: string; sure: boolean }>(null);
  const [check, setCheck] = useState<string | null>(null);
  const load = useCallback(() => call<Full>(`/api/work/tutorials/${id}`).then(setT).catch((e) => onError(e.message)), [id, onError]);
  useEffect(() => { load(); }, [load]);
  const busyJob = Boolean(t && Object.values(t.jobs).some((j) => j?.status === "working"));
  useEffect(() => { if (!busyJob) return; const i = setInterval(load, 4000); return () => clearInterval(i); }, [busyJob, load]);
  const d = useDictation(stt, (said) => setNotes((x) => ((x ?? t?.notes ?? "") ? `${x ?? t?.notes}\n${said}` : said)), onError);
  const dc = useDictation(stt, (said) => setCheck((x) => (x ? `${x} ${said}` : said)), onError);
  if (!t) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  const patch = (body: unknown) => act(() => call(`/api/work/tutorials/${id}`, json("PATCH", body)));
  const run = (skill: string, say?: string) => act(async () => { await call(`/api/work/tutorials/${id}/run`, json("POST", { skill, say })); setReply(""); });
  const ask = (body: { say?: string; find?: "outline" }) => act(async () => { await call(`/api/work/tutorials/${id}/check`, json("POST", body)); setCheck(null); });
  const skill = t.stage === "line_edit" ? "line_edit" : t.stage === "youtube_prep" ? "youtube_prep" : null;
  const job = skill ? t.jobs[skill] : null;
  const checking = t.jobs.check?.status === "working";

  const next = () => {
    if (t.filed_at) return <><span className="work-title">Filed away</span><div className="row"><button className="btn" onClick={() => patch({ filed: false })}>Bring it back</button></div></>;
    if (t.stage === "idea") return <><span className="work-title">Outline it</span><span className="muted">Talk it through with Claude and say "save the outline to Life Architect", or link the Google Doc below.</span></>;
    if (t.stage === "outline") return <><span className="work-title">Finish the outline</span><span className="muted">When the outline is ready to shoot from, move it on.</span><div className="row"><button className="btn primary" onClick={() => patch({ stage: "record" })}>Outline is ready</button></div></>;
    if (t.stage === "record") return <><span className="work-title">Record</span><span className="muted">Mark it once the footage is on the Mac.</span><div className="row"><button className="btn primary" onClick={() => patch({ stage: "line_edit" })}>It's recorded</button></div></>;
    if (t.stage === "live") return <><span className="work-title">It's live</span><div className="row"><button className="btn primary" onClick={() => act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { filed: true })); go({ at: "home" }); })}>File it away</button></div></>;
    const isEdit = t.stage === "line_edit";
    return (
      <>
        <span className="work-title">{isEdit ? "Line edit" : "YouTube prep"}</span>
        <span className="muted">{isEdit ? "Hermes finds the footage folder in Movies on the M5 Max, stitches the takes against the outline and puts a rough cut in Drive for Daniel. Its questions and the finished link come to you on Telegram." : "Hermes finds the upload on the channel, then writes the titles, description, chapters and tags and sets them on YouTube as private."}</span>
        {job?.status === "working" ? <span className="electro" role="status">Hermes is working on it…</span> : (
          <div className="row">
            <button className="btn primary" disabled={!t.has_model} onClick={() => run(skill!)}>{job ? `Run ${isEdit ? "line edit" : "YouTube prep"} again` : `Run ${isEdit ? "line edit" : "YouTube prep"}`}</button>
            <button className="btn" onClick={() => patch({ stage: t.next_stage!.id })}>{isEdit ? "Edit's done, move on" : "It's live"}</button>
          </div>
        )}
        {job && job.status !== "working" && job.reply && <div className={job.status === "failed" ? "hermes-says accent" : "hermes-says"}><span className="eyebrow electro">Hermes</span>{job.reply}</div>}
        {!isEdit && job?.status === "done" && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) run("youtube_prep", reply); }}>
            <label htmlFor="rp" className="sr">Reply to Hermes</label>
            <input id="rp" className="plain-input grow" type="text" placeholder="Reply, e.g. use the second title" value={reply} onChange={(e) => setReply(e.target.value)} />
            <button className="btn" type="submit" disabled={!reply.trim()}>Send</button>
          </form>
        )}
      </>
    );
  };

  const renameForm = edit && (
    <form className="row" onSubmit={(e) => { e.preventDefault(); act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { title: edit.title })); setEdit(null); }); }}>
      <label htmlFor="tt" className="sr">Tutorial name</label>
      <input id="tt" className="plain-input grow" type="text" autoFocus value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
      <button className="btn" type="submit" disabled={!edit.title.trim() || edit.title.trim() === t.title}>Rename</button>
    </form>
  );

  return (
    <div className="stack work">
      <Sub title={t.title} eyebrow="Sovereign Sessions" go={go} right={edit ? <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button> : <button className="btn ghost" onClick={() => setEdit({ title: t.title, sure: false })}>Edit</button>} />
      {edit && (
        <div className="card pad form">
          {renameForm}
          <div className="row">
          {!edit.sure ? <button className="btn ghost danger" onClick={() => setEdit({ ...edit, sure: true })}>Delete this tutorial…</button> : <><span className="accent small grow">This removes it and its notes, links and outline for good.</span><button className="btn danger" onClick={() => act(async () => { await call(`/api/work/tutorials/${id}`, { method: "DELETE" }); go({ at: "home" }); })}>Yes, delete</button><button className="btn ghost" onClick={() => setEdit({ ...edit, sure: false })}>Keep</button></>}
          </div>
        </div>
      )}
      <div className="stage-track">
        <Bars n={t.stage_number} />
        <div className="stage-names">{t.stages.map((s) => <button key={s.id} className={s.state} aria-label={`Move to ${s.name}`} aria-current={s.state === "now" ? "step" : undefined} onClick={() => s.state !== "now" && patch({ stage: s.id })}>{s.name.replace("YouTube", "YT")}</button>)}</div>
      </div>

      <section className="card pad hot stack"><span className="eyebrow accent">Next step</span>{next()}</section>

      {!t.filed_at && (
        <section className="stack">
          {checking ? <p className="electro" role="status" style={{ margin: 0 }}>Hermes is checking where it stands…</p> : check === null ? (
            <button className="linkish" style={{ alignSelf: "flex-start" }} onClick={() => setCheck("")}>Already further along? Have Hermes check</button>
          ) : (
            <div className="card pad form">
              <label htmlFor="ck" className="eyebrow">What's done</label>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <textarea id="ck" className="plain grow" placeholder={dc.recording ? `Listening… ${dc.clock}` : dc.busy ? "Writing it down…" : "e.g. Recorded Tuesday, Daniel has the rough cut. Leave blank to have Hermes work it out."} value={check} onChange={(e) => setCheck(e.target.value)} />
                <MicButton d={dc} small />
              </div>
              <span className="muted small">Hermes looks for the outline in Drive, the footage folder on the M5 Max and the upload on YouTube, then moves the tutorial to where it really is. It won't start an edit.</span>
              <div className="row"><button className="btn primary" disabled={!t.has_model} onClick={() => ask({ say: check })}>Check with Hermes</button><button className="btn ghost" onClick={() => setCheck(null)}>Cancel</button></div>
            </div>
          )}
          {t.jobs.check && t.jobs.check.status !== "working" && t.jobs.check.reply && check === null && <details className={t.jobs.check.status === "failed" ? "hermes-says accent" : "hermes-says"}><summary className="eyebrow electro">Hermes's last check · {when(t.jobs.check.created_at)}</summary>{t.jobs.check.reply}</details>}
        </section>
      )}

      <section className="stack">
        <span className="eyebrow">Outline</span>
        {t.outline_url && docLink === null && (
          <div className="card work-row">
            <a className="grow" href={t.outline_url} target="_blank" rel="noreferrer"><strong>Outline</strong><span className="muted small block">{docName(t.outline_url)} · opens in a new tab</span></a>
            <button className="btn ghost" onClick={() => setDocLink(t.outline_url)}>Change</button>
          </div>
        )}
        {docLink !== null && (
          <form className="card pad form" onSubmit={(e) => { e.preventDefault(); act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { outline_url: docLink })); setDocLink(null); }); }}>
            <label htmlFor="dl" className="eyebrow">Google Doc link</label>
            <input id="dl" className="plain-input" type="url" autoFocus autoCapitalize="off" placeholder="https://docs.google.com/document/…" value={docLink} onChange={(e) => setDocLink(e.target.value)} />
            <div className="row"><button className="btn" type="submit" disabled={!docLink.trim()}>Save link</button>{t.outline_url && <button className="btn ghost" type="button" onClick={() => act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { outline_url: "" })); setDocLink(null); })}>Unlink</button>}<button className="btn ghost" type="button" onClick={() => setDocLink(null)}>Cancel</button></div>
          </form>
        )}
        {!t.outline_url && docLink === null && (
          checking && t.log[0]?.text.includes("find the outline") ? <p className="electro" role="status" style={{ margin: 0 }}>Hermes is looking in Drive…</p> : (
            <div className="row">
              <button className="btn primary grow" disabled={!t.has_model || checking} onClick={() => ask({ find: "outline" })}>Find it in Drive</button>
              <button className="btn grow" onClick={() => setDocLink("")}>Link a Google Doc</button>
            </div>
          )
        )}
        {t.outline && !showOutline && <button className="card pad work-row" onClick={() => { setOutline(t.outline); setShowOutline(true); }}><span className="grow"><strong>Outline notes</strong><span className="muted small block">From {t.outline_from ?? "you"}</span></span><span className="muted">›</span></button>}
        {!t.outline && !t.outline_url && !showOutline && <button className="more" onClick={() => { setOutline(""); setShowOutline(true); }}>Or write the outline here</button>}
        {showOutline && (
          <div className="card pad form">
            <label htmlFor="ol" className="sr">Outline</label>
            <textarea id="ol" className="plain outline" value={outline ?? ""} onChange={(e) => setOutline(e.target.value)} />
            <div className="row"><button className="btn" onClick={() => act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { outline, outline_from: "you" })); setShowOutline(false); })}>Save</button><button className="btn ghost" onClick={() => setShowOutline(false)}>Close</button><button className="btn ghost" onClick={() => navigator.clipboard?.writeText(outline ?? "")}>Copy</button></div>
          </div>
        )}
      </section>

      <section className="stack">
        <span className="eyebrow">Notes</span>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <label htmlFor="nt" className="sr">Notes</label>
          <textarea id="nt" className="plain grow" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : "Angle, what to show on camera, things to check on shoot day"} value={notes ?? t.notes ?? ""} onChange={(e) => setNotes(e.target.value)} />
          <MicButton d={d} small />
        </div>
        {notes !== null && notes !== (t.notes ?? "") && <div className="row"><button className="btn" onClick={() => act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { notes })); setNotes(null); })}>Save notes</button><button className="btn ghost" onClick={() => setNotes(null)}>Undo</button></div>}
      </section>

      <section className="stack">
        <div className="row"><span className="eyebrow grow">Links and resources</span><button className="btn ghost" onClick={() => setLink(link ? null : { label: "", url: "" })}>+ Add</button></div>
        {link && (
          <form className="card pad form" onSubmit={(e) => { e.preventDefault(); act(async () => { await call(`/api/work/tutorials/${id}/links`, json("POST", link)); setLink(null); }); }}>
            <div className="fields">
              <label htmlFor="lu">Link<input id="lu" type="url" required autoCapitalize="off" placeholder="https://" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} /></label>
              <label htmlFor="ll">What it is<input id="ll" type="text" placeholder="Product page, affiliate link, doc…" value={link.label} onChange={(e) => setLink({ ...link, label: e.target.value })} /></label>
            </div>
            <div className="row"><button className="btn" type="submit">Add link</button></div>
          </form>
        )}
        {t.link_list.length === 0 && !link && <p className="muted small" style={{ margin: 0 }}>None yet.</p>}
        {t.link_list.map((l) => (
          <div key={l.id} className="card work-row"><a className="grow" href={l.url} target="_blank" rel="noreferrer">{l.label}<span className="muted small block">{new URL(l.url).hostname}</span></a><button className="btn ghost" aria-label={`Remove ${l.label}`} onClick={() => act(() => call(`/api/work/links/${l.id}`, { method: "DELETE" }))}>✕</button></div>
        ))}
      </section>

      <section className="stack">
        <button className="linkish" aria-expanded={details} onClick={() => setDetails(!details)}>Details and history {details ? "▾" : "▸"}</button>
        {details && (
          <div className="card pad form">
            <p className="muted small" style={{ margin: 0 }}>Hermes finds the footage folder and the upload itself, and fills these in when it does. Change them only if it picked the wrong one.</p>
            <div className="fields">
              <label htmlFor="fd">Footage folder in Movies on the M5 Max<input id="fd" type="text" defaultValue={t.folder ?? ""} placeholder="Hermes will find it" onBlur={(e) => e.target.value !== (t.folder ?? "") && patch({ folder: e.target.value })} /></label>
              <label htmlFor="vd">YouTube upload (link or video ID)<input id="vd" type="text" autoCapitalize="off" defaultValue={t.video_id ?? ""} placeholder="Hermes will find it" onBlur={(e) => e.target.value !== (t.video_id ?? "") && patch({ video_id: e.target.value })} /></label>
            </div>
            <ul className="list">{t.log.map((l, i) => <li key={i}><span className="when small muted">{when(l.ts)}</span><span className="grow small">{l.text}</span></li>)}</ul>
          </div>
        )}
      </section>

      {!t.filed_at && <div className="row"><button className="btn grow" onClick={() => go({ at: "home" })}>Back to the list</button><button className="btn grow" onClick={() => act(async () => { await call(`/api/work/tutorials/${id}`, json("PATCH", { filed: true })); go({ at: "home" }); })}>File it away</button></div>}
    </div>
  );
}

/* ---------- Bitcast ---------- */
function Bitcast({ go, onError, stt, id }: In & { id?: number }) {
  const [ep, setEp] = useState<Episode | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [say, setSay] = useState("");
  const [hand, setHand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const past = id !== undefined;
  const load = useCallback(() => call<Episode>(past ? `/api/work/bitcast/${id}` : "/api/work/bitcast").then(setEp).catch((e) => onError(e.message)), [id, past, onError]);
  useEffect(() => { load(); }, [load]);
  const working = ep?.job?.status === "working";
  useEffect(() => { if (!working) return; const i = setInterval(load, 4000); return () => clearInterval(i); }, [working, load]);
  const takes = ep?.takes.length ?? 0;
  useEffect(() => { setAt(null); }, [takes]);
  const d = useDictation(stt, (t) => setSay((x) => (x ? x + " " : "") + t), onError);
  if (!ep) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };
  const upload = (file: File | undefined) => { if (!file) return; const f = new FormData(); f.set("file", file); act(() => call("/api/work/bitcast/rundown", { method: "POST", body: f })); };
  const n = at ?? takes - 1, take = ep.takes[n];

  return (
    <div className="stack work">
      <Sub title={past ? `Bitcast · ${ep.day}` : "Bitcast, this week"} eyebrow="BTC Sessions" go={go} />

      {!past && (
        <section className="stack">
          <span className="eyebrow">1 · The rundown</span>
          {ep.file ? (
            <div className="card work-row"><span className="grow"><strong>{ep.file.name}</strong><span className="muted small block">{Math.max(1, Math.round(ep.file.size / 1024))} KB</span></span><label className="btn ghost as-link">Replace<input className="sr" type="file" accept="application/pdf,.pdf" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} /></label></div>
          ) : (
            <label className="btn as-link upload wide">Add the rundown PDF<input className="sr" type="file" accept="application/pdf,.pdf" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
          )}
          {working ? <p className="electro" role="status" style={{ margin: 0 }}>Hermes is working on it. This can take a few minutes…</p> : (
            <button className="btn primary wide" disabled={!ep.file || !ep.has_model} onClick={() => act(() => call("/api/work/bitcast/run", { method: "POST" }))}>{takes ? "Run Bitcast prep again" : "Run Bitcast prep"}</button>
          )}
          {!ep.has_model && <p className="muted small" style={{ margin: 0 }}>Set the deck model (Hermes) in Settings to run this.</p>}
          {ep.job?.status === "failed" && <p className="accent" style={{ margin: 0 }}>{ep.job.reply}</p>}
        </section>
      )}

      {take && (
        <section className="stack">
          <div className="row"><span className="eyebrow accent grow">{past ? "Intro hook" : "2 · Intro hook"}</span><span className="muted small">Take {n + 1} of {takes}</span></div>
          {hand === null ? <div className="card pad hot hook">{take.text}</div> : <><label htmlFor="hd" className="sr">Intro hook</label><textarea id="hd" className="plain outline" value={hand} onChange={(e) => setHand(e.target.value)} /></>}
          {take.asked && hand === null && <span className="muted small">{take.asked === "Edited by hand" ? take.asked : `You asked: ${take.asked}`}</span>}
          {hand === null ? (
            <div className="row">
              <button className="btn grow" disabled={n === 0} onClick={() => setAt(n - 1)}>‹ Earlier</button>
              <button className="btn grow" disabled={n >= takes - 1} onClick={() => setAt(n + 1)}>Later ›</button>
              <button className="btn grow" onClick={() => { navigator.clipboard?.writeText(take.text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy"}</button>
              {!past && <button className="btn grow" onClick={() => setHand(take.text)}>Edit by hand</button>}
            </div>
          ) : (
            <div className="row"><button className="btn" onClick={() => act(async () => { await call("/api/work/bitcast/takes", json("POST", { text: hand })); setHand(null); })}>Save as a new take</button><button className="btn ghost" onClick={() => setHand(null)}>Cancel</button></div>
          )}
          {hand !== null && <span className="muted small">A hand edit is saved here only. It doesn't update the sticky on the Mac; ask Hermes for that.</span>}
        </section>
      )}

      {take && !past && (
        <section className="stack">
          <label htmlFor="chg" className="eyebrow">3 · Tell it what to change</label>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <textarea id="chg" className="plain grow" placeholder={d.recording ? `Listening… ${d.clock}` : d.busy ? "Writing it down…" : "e.g. Punch up the second tease, and make the third a question"} value={say} onChange={(e) => setSay(e.target.value)} />
            <MicButton d={d} small />
          </div>
          <button className="btn wide" disabled={working || !say.trim()} onClick={() => act(async () => { await call("/api/work/bitcast/revise", json("POST", { say })); setSay(""); })}>{working ? "Working…" : "Make a new take"}</button>
          <span className="muted small">Each change goes to Hermes and comes back as a new take. Earlier takes are kept.</span>
        </section>
      )}

      {ep.report && <details className="card pad"><summary className="eyebrow">What else Hermes reported</summary><p className="handed" style={{ marginTop: 10 }}>{ep.report}</p></details>}

      {!past && <div className="row"><button className="btn grow" onClick={() => go({ at: "filed" })}>Past episodes</button><button className="btn grow" disabled={!ep.file && !takes} onClick={() => act(async () => { await call("/api/work/bitcast/file", { method: "POST" }); go({ at: "home" }); })}>File this one away</button></div>}
    </div>
  );
}

/* ---------- Filed away ---------- */
function Filed({ go, onError }: In) {
  const [f, setF] = useState<{ tutorials: Brief[]; episodes: Array<{ id: number; day: string }> } | null>(null);
  useEffect(() => { call<typeof f>("/api/work/filed").then(setF).catch((e) => onError(e.message)); }, [onError]);
  if (!f) return <p className="muted">Loading…</p>;
  return (
    <div className="stack work">
      <Sub title="Filed away" go={go} />
      <section className="stack">
        <span className="eyebrow">Tutorials · {f.tutorials.length}</span>
        {f.tutorials.length === 0 && <p className="muted small">Nothing filed yet.</p>}
        {f.tutorials.map((t) => <button key={t.id} className="card pad work-row" onClick={() => go({ at: "tutorial", id: t.id })}><span className="grow"><strong>{t.title}</strong><span className="muted small block">Filed {t.filed_at ? when(t.filed_at) : ""}</span></span><span className="muted">›</span></button>)}
      </section>
      <section className="stack">
        <span className="eyebrow">Bitcast episodes · {f.episodes.length}</span>
        {f.episodes.length === 0 && <p className="muted small">None filed yet.</p>}
        {f.episodes.map((e) => <button key={e.id} className="card pad work-row" onClick={() => go({ at: "bitcast", id: e.id })}><span className="grow"><strong>Bitcast · {e.day}</strong></span><span className="muted">›</span></button>)}
      </section>
    </div>
  );
}
