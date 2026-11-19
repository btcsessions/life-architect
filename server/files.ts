// Uploaded files (receipts, boarding passes, screenshots) live beside the database.
import type { Hono } from "hono";
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Ctx } from "./app.ts";

export interface StoredFile { id: number; name: string; mime: string; size: number; path: string; owner: string; created_at: string }

const MAX = 25 * 1024 * 1024;
let memoryDir: string | null = null;

export function dataDir(): string {
  const dbPath = process.env.LA_DB ?? "data/life.db";
  if (dbPath === ":memory:" || process.env.VITEST) return (memoryDir ??= mkdtempSync(join(tmpdir(), "la-")));
  return dirname(dbPath);
}

export function mountFiles(app: Hono, ctx: Ctx) {
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
    path TEXT NOT NULL, owner TEXT NOT NULL, created_at TEXT NOT NULL)`);

  // "owner" says which module a file belongs to; People files are only served through People's own locked route.
  app.get("/api/files/:id", (c) => {
    const f = ctx.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(c.req.param("id"))) as StoredFile | undefined;
    if (!f || f.owner === "people" || f.owner === "money") return c.json({ error: "No such file." }, 404);
    return serve(f);
  });
}

export function serve(f: StoredFile): Response {
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.mime);
  return new Response(readFileSync(join(dataDir(), f.path)), {
    headers: {
      "content-type": inline ? f.mime : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\w. -]/g, "_")}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function saveFile(ctx: Ctx, file: File, owner: string): Promise<StoredFile> {
  if (file.size === 0) throw new Error("That file is empty.");
  if (file.size > MAX) throw new Error("That file is over 25 MB.");
  const dir = join(dataDir(), "files", owner);
  mkdirSync(dir, { recursive: true });
  const rel = join("files", owner, randomBytes(12).toString("hex"));
  writeFileSync(join(dataDir(), rel), Buffer.from(await file.arrayBuffer()));
  const r = ctx.db
    .prepare("INSERT INTO files (name, mime, size, path, owner, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run((file.name || "file").slice(0, 200), file.type || "application/octet-stream", file.size, rel, owner, ctx.now().toISOString());
  return ctx.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(r.lastInsertRowid)) as StoredFile;
}

export function deleteFile(ctx: Ctx, id: number) {
  const f = ctx.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as StoredFile | undefined;
  if (!f) return;
  rmSync(join(dataDir(), f.path), { force: true });
  ctx.db.prepare("DELETE FROM files WHERE id = ?").run(id);
}
