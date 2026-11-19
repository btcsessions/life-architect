// Travel: trips with flights, stay, costs, documents and a personal schedule.
import type { Hono } from "hono";
import type { Ctx } from "./app.ts";
import { deleteFile, saveFile } from "./files.ts";

const KINDS = ["flight", "stay", "event", "cost", "doc"] as const;
type Kind = (typeof KINDS)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Trip { id: number; name: string; place: string | null; start: string | null; end: string | null; budget: number | null; currency: string; notes: string | null }
interface Item {
  id: number; trip_id: number; kind: Kind; title: string; day: string | null; time: string | null; end_day: string | null; end_time: string | null;
  location: string | null; url: string | null; cost: number | null; booked: number; details: string | null; file_id: number | null; task_id: number | null;
}

const TEXT = ["title", "location", "url", "details"] as const;

/** Check and tidy the fields of an item. Returns an error message or the cleaned values. */
export function cleanItem(body: Record<string, unknown>, partial: boolean): string | Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!partial || "kind" in body) {
    if (!KINDS.includes(body.kind as Kind)) return "Pick what kind of thing this is.";
    out.kind = body.kind;
  }
  if (!partial || "title" in body) {
    if (typeof body.title !== "string" || !body.title.trim()) return "Give it a name.";
  }
  for (const k of TEXT) if (k in body) out[k] = typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim().slice(0, 1000) : null;
  for (const k of ["day", "end_day"] as const) if (k in body) {
    if (body[k] && !DATE.test(String(body[k]))) return "Dates are YYYY-MM-DD.";
    out[k] = body[k] || null;
  }
  for (const k of ["time", "end_time"] as const) if (k in body) {
    if (body[k] && !TIME.test(String(body[k]))) return "Times are HH:MM.";
    out[k] = body[k] || null;
  }
  if ("url" in body && out.url && !/^https?:\/\//.test(String(out.url))) return "Links start with http:// or https://";
  if ("cost" in body) {
    if (body.cost !== null && body.cost !== "" && !(Number.isFinite(Number(body.cost)) && Number(body.cost) >= 0)) return "Cost is a number.";
    out.cost = body.cost === null || body.cost === "" ? null : Number(body.cost);
  }
  if ("booked" in body) out.booked = body.booked ? 1 : 0;
  return out;
}

const stamp = (day: string, time: string | null) => day.replace(/-/g, "") + (time ? `T${time.replace(":", "")}00` : "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

/** A calendar file any calendar app can import. Times are local ("floating"), as typed. */
export function toIcs(trip: Trip, items: Item[], nowIso: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Life Architect//Travel//EN", "CALSCALE:GREGORIAN"];
  for (const i of items) {
    if (!i.day || i.kind === "cost" || i.kind === "doc") continue;
    const allDay = !i.time;
    lines.push("BEGIN:VEVENT", `UID:trip-${trip.id}-item-${i.id}@life-architect`, `DTSTAMP:${nowIso.replace(/[-:]/g, "").slice(0, 15)}Z`);
    if (allDay) {
      const end = new Date(Date.UTC(+(i.end_day ?? i.day).slice(0, 4), +(i.end_day ?? i.day).slice(5, 7) - 1, +(i.end_day ?? i.day).slice(8, 10) + 1)).toISOString().slice(0, 10);
      lines.push(`DTSTART;VALUE=DATE:${stamp(i.day, null)}`, `DTEND;VALUE=DATE:${stamp(end, null)}`);
    } else {
      lines.push(`DTSTART:${stamp(i.day, i.time)}`);
      if (i.end_time || i.end_day) lines.push(`DTEND:${stamp(i.end_day ?? i.day, i.end_time ?? i.time)}`);
    }
    lines.push(`SUMMARY:${esc(i.title)}`);
    if (i.location) lines.push(`LOCATION:${esc(i.location)}`);
    const desc = [i.details, i.url].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function mountTravel(app: Hono, ctx: Ctx) {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, place TEXT, start TEXT, "end" TEXT,
      budget REAL, currency TEXT NOT NULL DEFAULT 'CAD', notes TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trip_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, title TEXT NOT NULL, day TEXT, time TEXT, end_day TEXT, end_time TEXT,
      location TEXT, url TEXT, cost REAL, booked INTEGER NOT NULL DEFAULT 0, details TEXT, file_id INTEGER, task_id INTEGER);
  `);

  const trip = (id: number) => db.prepare("SELECT * FROM trips WHERE id = ?").get(id) as Trip | undefined;
  const items = (id: number) =>
    db.prepare("SELECT i.*, f.name AS file_name FROM trip_items i LEFT JOIN files f ON f.id = i.file_id WHERE trip_id = ? ORDER BY day IS NULL, day, time IS NULL, time, i.id").all(id) as Item[];
  const totals = (list: Item[]) => ({
    to_book: list.filter((i) => (i.kind === "flight" || i.kind === "stay") && !i.booked).length,
    spent: list.reduce((s, i) => s + (i.cost && (i.kind === "cost" || i.booked) ? i.cost : 0), 0),
    planned: list.reduce((s, i) => s + (i.cost ?? 0), 0),
  });

  // A flight or stay that isn't booked yet is also a task on the deck, so "Next up" can rank it.
  function syncTask(i: Item, t: Trip) {
    const needs = (i.kind === "flight" || i.kind === "stay") && !i.booked;
    if (needs && !i.task_id) {
      const r = db.prepare("INSERT INTO tasks (area_id, title, importance, due, source, created_at) VALUES ('travel', ?, 2, ?, 'travel', ?)")
        .run(`Book ${i.title} (${t.name})`, null, ctx.now().toISOString());
      db.prepare("UPDATE trip_items SET task_id = ? WHERE id = ?").run(Number(r.lastInsertRowid), i.id);
    } else if (!needs && i.task_id) {
      db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(ctx.now().toISOString(), i.task_id);
    }
  }

  app.get("/api/trips", (c) =>
    c.json({ trips: (db.prepare('SELECT * FROM trips ORDER BY start IS NULL, start').all() as Trip[]).map((t) => ({ ...t, ...totals(items(t.id)) })) }),
  );

  app.post("/api/trips", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.name !== "string" || !b.name.trim()) return c.json({ error: "Give the trip a name." }, 400);
    for (const k of ["start", "end"]) if (b[k] && !DATE.test(String(b[k]))) return c.json({ error: "Dates are YYYY-MM-DD." }, 400);
    if (b.budget && !(Number(b.budget) >= 0)) return c.json({ error: "Budget is a number." }, 400);
    const r = db.prepare('INSERT INTO trips (name, place, start, "end", budget, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.name.trim(), (b.place as string)?.trim() || null, b.start || null, b.end || null, b.budget ? Number(b.budget) : null, ctx.now().toISOString());
    return c.json(trip(Number(r.lastInsertRowid)));
  });

  app.get("/api/trips/:id", (c) => {
    const t = trip(Number(c.req.param("id")));
    if (!t) return c.json({ error: "No such trip." }, 404);
    const list = items(t.id);
    return c.json({ trip: t, items: list, ...totals(list) });
  });

  app.patch("/api/trips/:id", async (c) => {
    const t = trip(Number(c.req.param("id")));
    if (!t) return c.json({ error: "No such trip." }, 404);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const k of ["name", "place", "start", "end", "budget", "notes"]) {
      if (!(k in b)) continue;
      if (k === "name" && !(typeof b.name === "string" && b.name.trim())) return c.json({ error: "Give the trip a name." }, 400);
      if ((k === "start" || k === "end") && b[k] && !DATE.test(String(b[k]))) return c.json({ error: "Dates are YYYY-MM-DD." }, 400);
      const v = k === "budget" ? (b.budget === "" || b.budget === null ? null : Number(b.budget)) : typeof b[k] === "string" ? (b[k] as string).trim() || null : null;
      if (k === "budget" && v !== null && !(Number(v) >= 0)) return c.json({ error: "Budget is a number." }, 400);
      db.prepare(`UPDATE trips SET "${k}" = ? WHERE id = ?`).run(v, t.id);
    }
    return c.json(trip(t.id));
  });

  app.delete("/api/trips/:id", (c) => {
    const id = Number(c.req.param("id"));
    for (const i of items(id)) {
      if (i.file_id) deleteFile(ctx, i.file_id);
      if (i.task_id) db.prepare("DELETE FROM tasks WHERE id = ? AND status = 'open'").run(i.task_id);
    }
    db.prepare("DELETE FROM trip_items WHERE trip_id = ?").run(id);
    return db.prepare("DELETE FROM trips WHERE id = ?").run(id).changes ? c.json({ ok: true }) : c.json({ error: "No such trip." }, 404);
  });

  function addItem(t: Trip, v: Record<string, unknown>): Item {
    const r = db.prepare(
      `INSERT INTO trip_items (trip_id, kind, title, day, time, end_day, end_time, location, url, cost, booked, details, file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, v.kind, v.title, v.day ?? null, v.time ?? null, v.end_day ?? null, v.end_time ?? null, v.location ?? null, v.url ?? null, v.cost ?? null, v.booked ?? 0, v.details ?? null, v.file_id ?? null);
    const i = db.prepare("SELECT * FROM trip_items WHERE id = ?").get(Number(r.lastInsertRowid)) as Item;
    syncTask(i, t);
    return db.prepare("SELECT * FROM trip_items WHERE id = ?").get(i.id) as Item;
  }

  app.post("/api/trips/:id/items", async (c) => {
    const t = trip(Number(c.req.param("id")));
    if (!t) return c.json({ error: "No such trip." }, 404);
    const type = c.req.header("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      // A document: a file, with an optional name.
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "Choose a file." }, 400);
      try {
        const saved = await saveFile(ctx, file, "travel");
        return c.json(addItem(t, { kind: "doc", title: String(form.get("title") || file.name).slice(0, 200), file_id: saved.id }));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    const v = cleanItem((await c.req.json().catch(() => ({}))) as Record<string, unknown>, false);
    if (typeof v === "string") return c.json({ error: v }, 400);
    return c.json(addItem(t, v));
  });

  app.patch("/api/trip-items/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const i = db.prepare("SELECT * FROM trip_items WHERE id = ?").get(id) as Item | undefined;
    if (!i) return c.json({ error: "That item is gone." }, 404);
    const v = cleanItem((await c.req.json().catch(() => ({}))) as Record<string, unknown>, true);
    if (typeof v === "string") return c.json({ error: v }, 400);
    for (const [k, val] of Object.entries(v)) db.prepare(`UPDATE trip_items SET ${k} = ? WHERE id = ?`).run(val as any, id);
    const after = db.prepare("SELECT * FROM trip_items WHERE id = ?").get(id) as Item;
    syncTask(after, trip(after.trip_id)!);
    return c.json(after);
  });

  app.delete("/api/trip-items/:id", (c) => {
    const id = Number(c.req.param("id"));
    const i = db.prepare("SELECT * FROM trip_items WHERE id = ?").get(id) as Item | undefined;
    if (!i) return c.json({ error: "That item is gone." }, 404);
    if (i.file_id) deleteFile(ctx, i.file_id);
    if (i.task_id) db.prepare("DELETE FROM tasks WHERE id = ? AND status = 'open'").run(i.task_id);
    db.prepare("DELETE FROM trip_items WHERE id = ?").run(id);
    return c.json({ ok: true });
  });

  app.get("/api/trips/:id/calendar.ics", (c) => {
    const t = trip(Number(c.req.param("id")));
    if (!t) return c.json({ error: "No such trip." }, 404);
    return new Response(toIcs(t, items(t.id), ctx.now().toISOString()), {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${t.name.replace(/[^\w -]/g, "_")}.ics"` },
    });
  });
}
