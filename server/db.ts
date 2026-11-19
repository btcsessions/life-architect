// One SQLite file holds the deck. Money and People get their own stores in later phases.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Area {
  id: string;
  name: string;
  sort: number;
  /** Sealed areas show a badge on the deck but never their task text (People). */
  locked: number;
}

export interface Task {
  id: number;
  area_id: string;
  title: string;
  note: string | null;
  /** 1 low, 2 medium, 3 high */
  importance: number;
  /** YYYY-MM-DD */
  due: string | null;
  minutes: number | null;
  status: "open" | "done";
  /** Set when someone else is doing it: it then counts as "moving without you". */
  delegate: string | null;
  /** YYYY-MM-DD; hidden from "Next up" until this day. */
  snoozed_until: string | null;
  source: string;
  created_at: string;
  done_at: string | null;
}

const AREAS: Array<[string, string, number]> = [
  ["work", "Work", 0],
  ["travel", "Travel & Speaking", 0],
  ["family", "Family", 0],
  ["health", "Health", 0],
  ["inbox", "Inbox", 0],
  ["hobbies", "Hobbies & Learning", 0],
  ["build", "Build & Automate", 0],
  ["money", "Money", 0],
  ["people", "People", 1],
];

export function openDb(path = process.env.LA_DB ?? "data/life.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area_id TEXT NOT NULL REFERENCES areas(id),
      title TEXT NOT NULL,
      note TEXT,
      importance INTEGER NOT NULL DEFAULT 2,
      due TEXT,
      minutes INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      delegate TEXT,
      snoozed_until TEXT,
      source TEXT NOT NULL DEFAULT 'app',
      created_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL, source TEXT NOT NULL, via TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_open ON tasks(status, area_id);
  `);
  const seed = db.prepare("INSERT OR IGNORE INTO areas (id, name, sort, locked) VALUES (?, ?, ?, ?)");
  AREAS.forEach(([id, name, locked], i) => seed.run(id, name, i, locked));
  return db;
}

export type Db = ReturnType<typeof openDb>;

/** Local calendar day as YYYY-MM-DD. The server's timezone is the user's (set TZ in the container). */
export function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
