// Quick-add: turn what was said or typed into filed tasks.
// Uses the configured model when there is one; otherwise (or on any failure) plain rules,
// so capture never depends on a model being reachable.
import { daysBetween } from "./rank.ts";

export interface Filed {
  area: string;
  title: string;
  importance: number;
  due: string | null;
  time: string | null;
  minutes: number | null;
  delegate: string | null;
  note: string | null;
}

/** Areas quick-add may file into. People is never auto-filed from the general quick-add. */
export const FILE_AREAS = ["work", "travel", "family", "health", "inbox", "hobbies", "build", "money"];

const AREA_WORDS: Array<[string, RegExp]> = [
  ["travel", /\b(flights?|hotels?|trip|airport|boarding|itinerary|airbnb|visa|speaking (gig|slot|invite)|conference)\b/i],
  ["inbox", /\b(e-?mails?|inbox|reply to|respond to|get back to)\b/i],
  ["health", /\b(work ?out|gym|run|lift|meals?|eat|diet|sleep|doctor|dentist|physio|stretch)\b/i],
  ["money", /\b(bank|invoice|tax(es)?|receipts?|budget|statement|accountant|expenses?)\b/i],
  ["family", /\b(birthday|anniversary|mom|mum|dad|wife|daughter|son|kids?|family|parents?|school)\b/i],
  ["hobbies", /\b(dance|class(es)?|lessons?|language|learn|hobby|guitar|climbing|hike|meetup|event)\b/i],
  ["build", /\b(automate|automation|script|agent|workflow|build (a|an|the))\b/i],
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

export function parseDue(text: string, day: string): string | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(t)) return day;
  if (/\btomorrow\b/.test(t)) return addDays(day, 1);
  const inN = t.match(/\bin (\d+) days?\b/);
  if (inN) return addDays(day, +inN[1]);
  if (/\bnext week\b/.test(t)) return addDays(day, 7);
  if (/\b(this|end of the) week\b/.test(t)) {
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    return addDays(day, (5 - dow + 7) % 7); // Friday
  }
  const wd = t.match(/\b(?:by|on|this|next|due)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    let n = (WEEKDAYS.indexOf(wd[1]) - dow + 7) % 7;
    if (n === 0) n = 7;
    return addDays(day, n);
  }
  return null;
}

/** A time of day as HH:MM: "at 3pm", "at 3:30 pm", "at 15:30", "at noon". */
export function parseTime(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bat noon\b/.test(t)) return "12:00";
  const m = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseMinutes(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bhalf an hour\b/.test(t)) return 30;
  if (/\ban hour\b/.test(t)) return 60;
  const h = t.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/);
  if (h) return Math.round(parseFloat(h[1]) * 60);
  const m = t.match(/\b(\d+)\s*(?:minutes?|mins?)\b/);
  if (m) return +m[1];
  return null;
}

export function parseImportance(text: string): number {
  if (/\b(urgent|asap|important|critical|high priority|top priority|must)\b/i.test(text)) return 3;
  if (/\b(low priority|whenever|someday|no rush|not urgent|eventually)\b/i.test(text)) return 1;
  return 2;
}

function parseDelegate(text: string): string | null {
  // Verbs may start the sentence; the name must be capitalised.
  const s = text ? text[0].toLowerCase() + text.slice(1) : text;
  const m =
    s.match(/\b(?:ask|get) ([A-Z][a-z]+) to\b/) ??
    s.match(/\bhave ([A-Z][a-z]+) (?!a\b|an\b|the\b)[a-z]+/) ??
    s.match(/\b(?:delegate|hand|assign) (?:this |it |that )?(?:off )?to ([A-Z][a-z]+)\b/);
  return m ? m[1] : null;
}

// Trailing "by Friday", "90 minutes", "important": already captured as fields, so not part of the title.
const META_TAIL =
  /[,\s]+(?:and\s+)?(?:it'?s\s+|that'?s\s+)?(?:(?:very\s+)?important|urgent|asap|(?:high|top|low) priority|no rush|(?:about|around|roughly|should take|takes|it takes)?\s*(?:\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)|half an hour|an hour)|(?:by|due|on|before)?\s*(?:today|tonight|tomorrow(?: morning| afternoon| evening)?|(?:this|next)\s+week|(?:this |next )?(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{4}-\d{2}-\d{2})|(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)|at\s+\d{1,2}:\d{2}|at noon)$/i;

function cleanTitle(clause: string): string {
  let s = clause
    .replace(/^\s*(and|also|oh|then|plus)[,\s]+/i, "")
    .replace(/^\s*(please\s+)?(remind me to|i need to|i have to|i've got to|i want to|i should|i'd like to|add|note to self[:,]?)\s+/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;!]+$/, "");
  for (let i = 0; i < 6 && META_TAIL.test(s); i++) {
    const cut = s.replace(META_TAIL, "").trim();
    if (cut.split(" ").length < 2) break; // never strip a title down to one word
    s = cut;
  }
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Rules-only filing. One task per sentence or line. */
export function fileByRules(text: string, day: string): Filed[] {
  const clauses = text
    .split(/(?<=[.!?;])\s+|\n+|\s+(?:and also|and then|oh and)\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.replace(/[^a-z0-9]/gi, "").length > 2);
  const out: Filed[] = [];
  for (const c of clauses) {
    const title = cleanTitle(c);
    if (!title) continue;
    const link = c.match(/https?:\/\/\S+/);
    out.push({
      area: AREA_WORDS.find(([, re]) => re.test(c))?.[0] ?? "work",
      title,
      importance: parseImportance(c),
      due: parseDue(c, day),
      time: parseTime(c),
      minutes: parseMinutes(c),
      delegate: parseDelegate(c),
      note: link ? link[0] : null,
    });
  }
  return out;
}

const SYSTEM = (day: string) => `You file a person's spoken or typed notes into tasks. Today is ${day}.
Return ONLY a JSON array. Each item: {"area": one of ${JSON.stringify(FILE_AREAS)}, "title": short imperative title in their words,
"importance": 1 (low) | 2 (medium) | 3 (high), "due": "YYYY-MM-DD" or null, "time": "HH:MM" (24h) or null only if they gave a time of day, "minutes": estimated minutes or null only if they said it,
"delegate": first name of the person who should do it or null, "note": any link they gave or null}.
One item per distinct thing to do. Do not invent tasks, dates or people.`;

function validate(raw: unknown, day: string): Filed[] {
  if (!Array.isArray(raw)) throw new Error("not an array");
  const out: Filed[] = [];
  for (const r of raw as any[]) {
    if (!r || typeof r.title !== "string" || !r.title.trim()) continue;
    const due = typeof r.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.due) && Math.abs(daysBetween(day, r.due)) < 3660 ? r.due : null;
    out.push({
      area: FILE_AREAS.includes(r.area) ? r.area : "work",
      title: r.title.trim().slice(0, 200),
      importance: [1, 2, 3].includes(r.importance) ? r.importance : 2,
      due,
      time: due && typeof r.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : null,
      minutes: Number.isFinite(r.minutes) && r.minutes > 0 && r.minutes < 6000 ? Math.round(r.minutes) : null,
      delegate: typeof r.delegate === "string" && r.delegate.trim() ? r.delegate.trim().slice(0, 60) : null,
      note: typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 500) : null,
    });
  }
  if (!out.length) throw new Error("empty");
  return out;
}

export interface ModelConfig {
  url: string; // OpenAI-compatible base, e.g. http://hermes:8000/v1
  key?: string;
  model: string;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** One chat-completions call. Throws with a plain reason on any failure. */
export async function chat(cfg: ModelConfig, messages: ChatMessage[], timeoutMs = 60_000, fetchFn: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(`${cfg.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify({ model: cfg.model, temperature: 0.2, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "TimeoutError" ? "the model took too long to answer" : "the model couldn't be reached");
  }
  if (res.status === 401 || res.status === 403) throw new Error("the model refused the key");
  if (!res.ok) throw new Error(`the model answered with an error (${res.status})`);
  const body: any = await res.json().catch(() => null);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("the model sent back an empty answer");
  return content.trim();
}

/** Pull the first JSON object or array out of a model's answer. */
export function extractJson(content: string): unknown {
  const starts = [content.indexOf("{"), content.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("the model didn't answer in the expected format");
  const start = Math.min(...starts);
  const end = Math.max(content.lastIndexOf("}"), content.lastIndexOf("]"));
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error("the model didn't answer in the expected format");
  }
}

export function modelFromEnv(): ModelConfig | null {
  const url = process.env.LLM_URL;
  const model = process.env.LLM_MODEL;
  return url && model ? { url: url.replace(/\/$/, ""), key: process.env.LLM_KEY, model } : null;
}

export async function fileCapture(
  text: string,
  day: string,
  cfg: ModelConfig | null = modelFromEnv(),
  fetchFn: typeof fetch = fetch,
): Promise<{ items: Filed[]; via: "model" | "rules" }> {
  if (cfg) {
    try {
      const res = await fetchFn(`${cfg.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM(day) },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`model ${res.status}`);
      const body: any = await res.json();
      const content: string = body?.choices?.[0]?.message?.content ?? "";
      const json = content.slice(content.indexOf("["), content.lastIndexOf("]") + 1);
      return { items: validate(JSON.parse(json), day), via: "model" };
    } catch (err) {
      console.warn("[file] model filing failed, using rules:", (err as Error).message);
    }
  }
  return { items: fileByRules(text, day), via: "rules" };
}
