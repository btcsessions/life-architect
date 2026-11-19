import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

const app = createApp(openDb());

// The built web app, with a fallback to index.html for the single page.
if (existsSync("dist/web/index.html")) {
  app.use("/*", serveStatic({ root: "dist/web" }));
  const index = readFileSync("dist/web/index.html", "utf8");
  app.get("*", (c) => c.html(index));
}

const port = Number(process.env.PORT ?? 4600);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () =>
  console.log(`Life Architect listening on :${port}`),
);
