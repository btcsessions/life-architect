// The main screen can drive every module. Quick-add text goes to the deck model once; besides tasks and asks it can
// return actions for Travel, Money, Inbox and existing tasks, which are carried out here.
// Two things stay behind a tap: sending email, and anything in People (which the deck model never sees).
import type { Hono } from "hono";
import type { Ctx } from "./app.ts";

export interface Did {
  module: string; text: string; ok: boolean; detail?: string;
  /** A follow-up that needs his tap, e.g. Send. */
  action?: { label: string; path: string; body: unknown; done: string };
  open?: "travel" | "money" | "people" | "inbox";
}
export const ACTION_KINDS = ["done", "change", "trip", "trip_item", "expense", "email"];

export const ROUTER = `
Other kinds, used ONLY when the person clearly asks for that thing. Use ids from the lists at the end; never invent an id.
{"kind":"done","task_id":n}: they say an existing task is finished.
{"kind":"change","task_id":n, plus any of "due","time","importance","delegate"}: they change an existing task.
{"kind":"trip","name":short name,"place":where or null,"start":"YYYY-MM-DD" or null,"end":"YYYY-MM-DD" or null,"budget":number or null}: a new trip.
{"kind":"trip_item","trip_id":n,"type":"flight"|"stay"|"event"|"cost","title":...,"day":"YYYY-MM-DD" or null,"time":"HH:MM" or null,"cost":number or null,"booked":true|false}: a booking, plan or cost for a listed trip.
{"kind":"expense","description":what it was,"amount":number,"day":"YYYY-MM-DD" or null,"direction":"out"|"in"}: money they spent or received, when they ask to log it.
{"kind":"email","find":the words that identify the email (sender, company, subject),"do":"reply"|"handoff"|"task"|"ask","say":what to reply, the note for the hand-off, the task, or the instruction,"to":name of the person to hand it to or null}: something about an email they received. "ask" means you, the assistant, should do something with that email (make a note from it, pull details out).`;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9@. ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["the", "email", "mail", "message", "from", "about", "that", "this", "with", "for", "and", "one", "sent", "got", "their", "his", "her", "them", "regarding"]);

export function mountCommands(app: Hono, ctx: Ctx, deps: { addTx: (day: string, description: string, amount: number, account: string | null) => boolean; peopleDrop: (text: string, source: string) => void }) {
  const { db } = ctx;
  const post = async (path: string, body: unknown, method = "POST") => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(j.error ?? "That didn't work.");
    return j;
  };
  const openTasks = () => db.prepare("SELECT t.id, t.title FROM tasks t JOIN areas a ON a.id = t.area_id WHERE t.status = 'open' AND a.locked = 0 ORDER BY t.id DESC LIMIT 40").all() as Array<{ id: number; title: string }>;
  const trips = () => db.prepare('SELECT id, name, place, start FROM trips ORDER BY id DESC LIMIT 12').all() as Array<{ id: number; name: string }>;
  const people = () => db.prepare("SELECT name, email FROM mail_rules GROUP BY lower(email)").all() as Array<{ name: string; email: string }>;

  /** What the model needs to know to pick ids. No People, no money figures, no email text. */
  const context = () => `\nOpen tasks: ${JSON.stringify(openTasks())}\nTrips: ${JSON.stringify(trips())}\nPeople email can be handed to: ${JSON.stringify(people().map((p) => p.name))}`;

  /** The synced email that best matches a few identifying words. */
  function findMail(find: string): { mail: any; unsure: boolean } | null {
    const q = words(find);
    if (!q.length) return null;
    const scored = (db.prepare("SELECT * FROM mail ORDER BY date DESC LIMIT 300").all() as any[]).map((m) => {
      const head = `${m.from_name} ${m.from_addr} ${m.subject}`.toLowerCase(), body = m.body.toLowerCase().slice(0, 3000);
      let score = 0;
      for (const w of q) score += head.includes(w) ? 3 : body.includes(w) ? 1 : 0;
      return { m, score: score + (m.status === "new" ? 0.5 : 0) };
    }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score);
    return scored.length ? { mail: scored[0].m, unsure: scored.length > 1 && scored[1].score === scored[0].score } : null;
  }

  async function one(a: any): Promise<Did> {
    switch (a.kind) {
      case "done": case "change": {
        const t = openTasks().find((x) => x.id === Number(a.task_id));
        if (!t) return { module: "Deck", ok: false, text: "Couldn't tell which task you meant. Nothing was changed." };
        if (a.kind === "done") { await post(`/api/tasks/${t.id}`, { status: "done" }, "PATCH"); return { module: "Deck", ok: true, text: `Marked done: ${t.title}` }; }
        const patch: Record<string, unknown> = {};
        for (const [from, to] of [["due", "due"], ["time", "due_time"], ["importance", "importance"], ["delegate", "delegate"]] as const) if (a[from] !== undefined && a[from] !== null) patch[to] = a[from];
        if (!Object.keys(patch).length) return { module: "Deck", ok: false, text: `Not sure what to change on "${t.title}".` };
        await post(`/api/tasks/${t.id}`, patch, "PATCH");
        return { module: "Deck", ok: true, text: `Updated: ${t.title}`, detail: Object.entries(patch).map(([k, v]) => `${k.replace("due_time", "time")}: ${v}`).join(" · ") };
      }
      case "trip": {
        const t = await post("/api/trips", { name: a.name, place: a.place ?? undefined, start: a.start ?? undefined, end: a.end ?? undefined, budget: a.budget ?? undefined });
        return { module: "Travel", ok: true, text: `Trip added: ${t.name}`, detail: [t.place, t.start && `${t.start}${t.end ? ` to ${t.end}` : ""}`].filter(Boolean).join(" · ") || undefined, open: "travel" };
      }
      case "trip_item": {
        const t = trips().find((x) => x.id === Number(a.trip_id));
        if (!t) return { module: "Travel", ok: false, text: "Couldn't tell which trip that belongs to. Nothing was added.", open: "travel" };
        const body: Record<string, unknown> = { kind: a.type, title: a.title, booked: Boolean(a.booked) };
        for (const k of ["day", "time", "cost"]) if (a[k] !== undefined && a[k] !== null) body[k] = a[k];
        const i = await post(`/api/trips/${t.id}/items`, body);
        return { module: "Travel", ok: true, text: `Added to ${t.name}: ${i.title}`, detail: [i.day, i.time, i.cost != null && `$${i.cost}`, i.booked ? "booked" : (i.kind === "flight" || i.kind === "stay") && "not booked yet"].filter(Boolean).join(" · ") || undefined, open: "travel" };
      }
      case "expense": {
        const amount = Math.abs(Number(a.amount)), description = String(a.description ?? "").trim().slice(0, 200);
        if (!(amount > 0) || !description) return { module: "Money", ok: false, text: "Couldn't read the amount or what it was for. Nothing was logged." };
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a.day)) ? String(a.day) : ctx.day();
        const added = deps.addTx(day, description, a.direction === "in" ? amount : -amount, "By hand");
        return { module: "Money", ok: added, text: added ? `Logged ${a.direction === "in" ? "money in" : "spending"}: ${description}, $${amount.toFixed(2)}` : "That exact entry is already in Money.", open: "money" };
      }
      case "email": {
        const hit = findMail(String(a.find ?? ""));
        if (!hit) return { module: "Inbox", ok: false, text: `Couldn't find an email matching "${String(a.find ?? "").slice(0, 80)}". It only knows mail from the last few days.`, open: "inbox" };
        const m = hit.mail, which = `"${m.subject}" from ${m.from_name}${hit.unsure ? " (more than one matched; this is the newest)" : ""}`;
        const say = String(a.say ?? "").trim();
        if (a.do === "reply") {
          if (!say) return { module: "Inbox", ok: false, text: `Found ${which}, but not what you want to say.`, open: "inbox" };
          const d = await post(`/api/inbox/${m.id}/draft`, { say });
          db.prepare("UPDATE mail SET draft = ? WHERE id = ?").run(d.text, m.id);
          return { module: "Inbox", ok: true, text: `Reply drafted to ${which}. Not sent yet.`, detail: d.text, action: { label: "Send", path: `/api/inbox/${m.id}/send`, body: { text: d.text }, done: `Sent to ${m.from_name}.` }, open: "inbox" };
        }
        if (a.do === "handoff") {
          const p = people().find((x) => x.name.toLowerCase() === String(a.to ?? "").toLowerCase() || x.name.toLowerCase().split(" ")[0] === String(a.to ?? "").toLowerCase());
          if (!p) return { module: "Inbox", ok: false, text: `Found ${which}, but there's no email address on file for ${a.to || "that person"}. Hand it off once from Inbox and it'll work from here after.`, open: "inbox" };
          return { module: "Inbox", ok: true, text: `Ready to hand ${which} to ${p.name}. Not sent yet.`, detail: say || undefined, action: { label: `Send to ${p.name}`, path: `/api/inbox/${m.id}/handoff`, body: { name: p.name, email: p.email, note: say }, done: `Handed to ${p.name}.` }, open: "inbox" };
        }
        if (a.do === "task") {
          const r = await post(`/api/inbox/${m.id}/task`, { text: say || `Deal with ${m.subject}` });
          return { module: "Inbox", ok: true, text: `Task added about ${which}`, detail: r.created.map((t: any) => t.title).join("; ") };
        }
        if (!say) return { module: "Inbox", ok: false, text: `Found ${which}, but not what to do with it.`, open: "inbox" };
        await post("/api/asks", { text: say, mail_id: m.id });
        return { module: "Hermes", ok: true, text: `Handed to Hermes with ${which}. Its answer will show above.` };
      }
    }
    return { module: "Deck", ok: false, text: "Didn't understand part of that." };
  }

  async function run(actions: any[]): Promise<Did[]> {
    const out: Did[] = [];
    for (const a of actions.slice(0, 12)) {
      try { out.push(await one(a)); } catch (e) { out.push({ module: "Deck", ok: false, text: (e as Error).message }); }
    }
    return out;
  }

  /** "People: ..." goes straight into People's handed-over list. No model reads it. */
  function people_(text: string): Did[] | null {
    const m = text.match(/^\s*people\s*[:,\-]\s*([\s\S]+)/i);
    if (!m) return null;
    deps.peopleDrop(m[1].trim(), "deck");
    return [{ module: "People", ok: true, text: "Saved to People's handed-over list. Open People to file it.", open: "people" }];
  }

  return { context, run, people: people_ };
}
