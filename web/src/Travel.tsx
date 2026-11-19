import { useCallback, useEffect, useState } from "react";
import { call, json } from "./api";
import { ScreenHead, money } from "./ui";

interface Trip { id: number; name: string; place: string | null; start: string | null; end: string | null; budget: number | null; to_book?: number; spent?: number }
interface Item {
  id: number; kind: "flight" | "stay" | "event" | "cost" | "doc"; title: string; day: string | null; time: string | null; end_day: string | null; end_time: string | null;
  location: string | null; url: string | null; cost: number | null; booked: number; details: string | null; file_id: number | null; file_name?: string | null;
}
interface TripView { trip: Trip; items: Item[]; to_book: number; spent: number; planned: number }
type Props = { onBack: () => void; onError: (m: string) => void };

const day = (d: string | null) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" }) : "");
const range = (t: Trip) => (t.start ? `${day(t.start)}${t.end && t.end !== t.start ? ` to ${day(t.end)}` : ""}` : "No dates yet");

/** A link that opens Google Calendar with this event filled in. Nothing is sent until you press Save there. */
export function calendarLink(i: Item): string {
  const d = (s: string) => s.replace(/-/g, "");
  let dates: string;
  if (!i.time) {
    const end = new Date((i.end_day ?? i.day!) + "T12:00:00");
    end.setDate(end.getDate() + 1);
    dates = `${d(i.day!)}/${d(end.toISOString().slice(0, 10))}`;
  } else {
    const t = (s: string) => s.replace(":", "") + "00";
    let endTime = i.end_time;
    if (!endTime) {
      const [h, m] = i.time.split(":").map(Number);
      endTime = `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    dates = `${d(i.day!)}T${t(i.time)}/${d(i.end_day ?? i.day!)}T${t(endTime)}`;
  }
  const q = new URLSearchParams({ action: "TEMPLATE", text: i.title, dates });
  if (i.location) q.set("location", i.location);
  const details = [i.details, i.url].filter(Boolean).join("\n");
  if (details) q.set("details", details);
  return `https://calendar.google.com/calendar/render?${q}`;
}
const mapLink = (place: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

export function Travel({ onBack, onError }: Props) {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", place: "", start: "", end: "", budget: "" });

  const load = useCallback(() => call<{ trips: Trip[] }>("/api/trips").then((r) => setTrips(r.trips)).catch((e) => onError(e.message)), [onError]);
  useEffect(() => { load(); }, [load]);

  if (open !== null) return <TripScreen id={open} onBack={() => { setOpen(null); load(); }} onError={onError} />;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const t = await call<Trip>("/api/trips", json("POST", form));
      setForm({ name: "", place: "", start: "", end: "", budget: "" });
      setOpen(t.id);
    } catch (err) { onError((err as Error).message); }
  };

  return (
    <div className="stack">
      <ScreenHead title="Trips" eyebrow="Travel & Speaking" onBack={onBack} />
      {trips === null ? <p className="muted">Loading…</p> : trips.length === 0 ? <p className="muted">No trips yet. Add the first one below.</p> : (
        <div className="grid-2">
          {trips.map((t) => (
            <button key={t.id} className="card pad trip-card" onClick={() => setOpen(t.id)}>
              <span className="module-name">{t.name}</span>
              <span className="muted small">{[t.place, range(t)].filter(Boolean).join(" · ")}</span>
              <span className={t.to_book ? "small accent" : "small electro"}>{t.to_book ? `${t.to_book} left to book` : "Everything booked"}{t.budget ? ` · ${money(t.spent ?? 0)} of ${money(t.budget)}` : ""}</span>
            </button>
          ))}
        </div>
      )}
      <form className="card pad form" onSubmit={create}>
        <span className="eyebrow">New trip</span>
        <div className="fields">
          <label htmlFor="tn">Name<input id="tn" type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label htmlFor="tp">Where<input id="tp" type="text" value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} /></label>
          <label htmlFor="ts">From<input id="ts" type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
          <label htmlFor="te">To<input id="te" type="date" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
          <label htmlFor="tb">Budget<input id="tb" type="number" min="0" inputMode="decimal" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} /></label>
        </div>
        <div className="row"><button className="btn" type="submit">Add trip</button></div>
      </form>
    </div>
  );
}

const EMPTY = { kind: "event", title: "", day: "", time: "", end_time: "", end_day: "", location: "", url: "", cost: "", booked: false, details: "" };

function TripScreen({ id, onBack, onError }: { id: number } & Props) {
  const [v, setV] = useState<TripView | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => call<TripView>(`/api/trips/${id}`).then(setV).catch((e) => onError(e.message)), [id, onError]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await load(); } catch (e) { onError((e as Error).message); } };

  if (!v) return <p className="muted">Loading…</p>;
  const of = (k: Item["kind"]) => v.items.filter((i) => i.kind === k);
  const schedule = v.items.filter((i) => i.day && (i.kind === "event" || i.kind === "flight"));
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    act(async () => {
      await call(`/api/trips/${id}/items`, json("POST", form));
      setForm({ ...EMPTY, kind: form.kind, day: form.day });
      setAdding(false);
    });
  };
  const upload = (file: File | undefined) => {
    if (!file) return;
    const data = new FormData();
    data.set("file", file);
    act(() => call(`/api/trips/${id}/items`, { method: "POST", body: data }));
  };
  const remove = (i: Item) => act(() => call(`/api/trip-items/${i.id}`, { method: "DELETE" }));

  const Booking = ({ i }: { i: Item }) => (
    <li>
      <span className="grow">
        <strong>{i.title}</strong>
        <span className="muted small block">{[day(i.day) + (i.time ? ` at ${i.time}` : ""), i.end_day && i.end_day !== i.day ? `until ${day(i.end_day)}` : "", i.location, i.cost != null ? money(i.cost) : ""].filter(Boolean).join(" · ")}</span>
        {i.url && <a className="small" href={i.url} target="_blank" rel="noreferrer">Open link</a>}
      </span>
      <button className={i.booked ? "status ok" : "status hot"} aria-pressed={Boolean(i.booked)} onClick={() => act(() => call(`/api/trip-items/${i.id}`, json("PATCH", { booked: !i.booked })))}>
        {i.booked ? "Booked" : "Not booked"}
      </button>
      <button className="btn ghost" aria-label={`Remove ${i.title}`} onClick={() => remove(i)}>✕</button>
    </li>
  );

  return (
    <div className="stack">
      <ScreenHead title={v.trip.name} eyebrow={[v.trip.place, range(v.trip)].filter(Boolean).join(" · ")} onBack={onBack} />
      <p className={v.to_book ? "accent" : "electro"} style={{ margin: 0 }}>
        {v.to_book ? `${v.to_book} left to book` : "Everything booked"}
        {v.trip.budget ? ` · ${money(v.spent)} of ${money(v.trip.budget)} spent` : v.spent ? ` · ${money(v.spent)} spent` : ""}
      </p>

      <div className="grid-2">
        <section className="card pad">
          <span className="eyebrow electro">Flights</span>
          {of("flight").length ? <ul className="list">{of("flight").map((i) => <Booking key={i.id} i={i} />)}</ul> : <p className="muted small">None yet.</p>}
        </section>
        <section className="card pad">
          <span className="eyebrow electro">Stay</span>
          {of("stay").length ? <ul className="list">{of("stay").map((i) => <Booking key={i.id} i={i} />)}</ul> : <p className="muted small">None yet.</p>}
        </section>
      </div>

      <section className="card pad">
        <span className="eyebrow electro">Your schedule</span>
        {schedule.length === 0 ? <p className="muted small">Nothing scheduled yet. Add events with a day and time.</p> : (
          <ul className="list">
            {schedule.map((i) => (
              <li key={i.id}>
                <span className="when accent small">{day(i.day)}{i.time ? <><br />{i.time}</> : null}</span>
                <span className="grow">
                  <strong>{i.title}</strong>
                  <span className="row small">
                    {i.location && <a href={mapLink(i.location)} target="_blank" rel="noreferrer">Map · {i.location}</a>}
                    {i.url && <a href={i.url} target="_blank" rel="noreferrer">Event page</a>}
                    <a href={calendarLink(i)} target="_blank" rel="noreferrer">Add to Google Calendar</a>
                  </span>
                </span>
                {i.kind === "event" && <button className="btn ghost" aria-label={`Remove ${i.title}`} onClick={() => remove(i)}>✕</button>}
              </li>
            ))}
          </ul>
        )}
        {schedule.length > 0 && <div className="row"><a className="btn as-link" href={`/api/trips/${id}/calendar.ics`}>Download the whole schedule (.ics)</a></div>}
      </section>

      <div className="grid-2">
        <section className="card pad">
          <span className="eyebrow electro">Docs · kept with the trip</span>
          {of("doc").length === 0 ? <p className="muted small">Boarding passes, confirmations, receipts. Upload a file or add a link.</p> : (
            <ul className="list">
              {of("doc").map((i) => (
                <li key={i.id}>
                  <span className="grow">
                    {i.file_id ? <a href={`/api/files/${i.file_id}`} target="_blank" rel="noreferrer">{i.title}</a> : i.url ? <a href={i.url} target="_blank" rel="noreferrer">{i.title}</a> : i.title}
                    {i.details && <span className="muted small block">{i.details}</span>}
                  </span>
                  <button className="btn ghost" aria-label={`Remove ${i.title}`} onClick={() => remove(i)}>✕</button>
                </li>
              ))}
            </ul>
          )}
          <label className="btn as-link upload">Upload a file<input className="sr" type="file" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} /></label>
        </section>
        <section className="card pad">
          <span className="eyebrow electro">Costs</span>
          <div className="row"><span className="big">{money(v.spent)}</span>{v.trip.budget != null && <span className="muted">of {money(v.trip.budget)}</span>}</div>
          {v.planned > v.spent && <p className="muted small">{money(v.planned - v.spent)} more once everything is booked.</p>}
          <ul className="list">
            {v.items.filter((i) => i.cost != null).map((i) => (
              <li key={i.id}><span className="grow">{i.title}</span><span className={i.kind === "cost" || i.booked ? "" : "muted"}>{money(i.cost!)}</span>{i.kind === "cost" && <button className="btn ghost" aria-label={`Remove ${i.title}`} onClick={() => remove(i)}>✕</button>}</li>
            ))}
          </ul>
        </section>
      </div>

      {adding ? (
        <form className="card pad form" onSubmit={add}>
          <span className="eyebrow">Add to this trip</span>
          <div className="fields">
            <label htmlFor="ik">What
              <select id="ik" value={form.kind} onChange={set("kind")}>
                <option value="flight">Flight</option><option value="stay">Stay</option><option value="event">Event or plan</option><option value="cost">Cost</option><option value="doc">Link to a doc or email</option>
              </select>
            </label>
            <label htmlFor="it">Name<input id="it" type="text" required value={form.title} onChange={set("title")} /></label>
            {form.kind !== "cost" && form.kind !== "doc" && <label htmlFor="id">Day<input id="id" type="date" value={form.day} onChange={set("day")} /></label>}
            {(form.kind === "event" || form.kind === "flight") && <label htmlFor="itm">Time<input id="itm" type="time" value={form.time} onChange={set("time")} /></label>}
            {form.kind === "event" && <label htmlFor="ie">Ends<input id="ie" type="time" value={form.end_time} onChange={set("end_time")} /></label>}
            {form.kind === "stay" && <label htmlFor="ied">Until<input id="ied" type="date" value={form.end_day} onChange={set("end_day")} /></label>}
            {form.kind !== "cost" && form.kind !== "doc" && <label htmlFor="il">Where<input id="il" type="text" value={form.location} onChange={set("location")} /></label>}
            {form.kind !== "cost" && <label htmlFor="iu">Link<input id="iu" type="text" inputMode="url" placeholder="https://…" value={form.url} onChange={set("url")} /></label>}
            {form.kind !== "doc" && <label htmlFor="ic">Cost<input id="ic" type="number" min="0" step="0.01" inputMode="decimal" value={form.cost} onChange={set("cost")} /></label>}
          </div>
          {(form.kind === "flight" || form.kind === "stay") && (
            <label className="check" htmlFor="ib"><input id="ib" type="checkbox" checked={form.booked} onChange={(e) => setForm({ ...form, booked: e.target.checked })} /><span>Already booked</span></label>
          )}
          <div className="row"><button className="btn" type="submit">Add</button><button className="btn ghost" type="button" onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)}>Add a flight, stay, event, cost or link</button>
          <button className="btn ghost danger" onClick={() => { if (window.confirm(`Delete "${v.trip.name}" and everything in it?`)) call(`/api/trips/${id}`, { method: "DELETE" }).then(onBack).catch((e) => onError(e.message)); }}>Delete trip</button>
        </div>
      )}
    </div>
  );
}
