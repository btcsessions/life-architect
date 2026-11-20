// The connector Claude (or any MCP client) uses from anywhere, including the phone app by voice.
// It runs on its own port so that only this small door needs to be reachable from the internet; the deck, Money and
// People stay on the private network. Every call needs the relay token. Nothing here can read or write People,
// and nothing here can send an email: replies and hand-offs are drafted and wait for a tap in the app.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

interface Deck {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  capture: (text: string, source: string, opts?: { tasksOnly?: boolean; full?: boolean }) => Promise<{ created: any[]; asked: any[]; did: any[] }>;
  relayToken: () => string | null;
}
const PEOPLE = /^\s*people\s*[:,\-]/i;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function build(app: Deck, token: string) {
  const server = new McpServer({ name: "life-architect", version: "1.0.0" }, {
    instructions: "Ben's Life Architect deck on his own server. Use `do` for anything he wants added, changed, logged or handled, passing his own words. Use `whats_next` when he asks what's on his plate. Never send notes about people or relationships here; tell him to add those in the app's People section himself. Emails are only ever drafted: tell him to open the app to send.",
  });
  const auth = { authorization: `Bearer ${token}` };
  const get = async (path: string) => (await app.request(path, { headers: auth })).json() as Promise<any>;

  server.registerTool("do", {
    title: "Add or do something in Life Architect",
    description: "Pass what Ben said, in his words. Handles: new tasks (with due date, importance, time needed, who to hand to); marking a task done or changing it; a new trip or a booking/cost on a trip; logging money spent or received; something about an email he received, found by sender or subject (draft a reply, hand it off, make a task, or have his assistant Hermes act on it); and instructions for Hermes like 'make a note of…' or 'look up…'. Several things can go in one call. Returns what was done and anything that still needs him.",
    inputSchema: { text: z.string().min(1).max(4000).describe("What he wants, in his own words") },
  }, async ({ text: said }) => {
    if (PEOPLE.test(said)) return text("Not done: notes about people aren't accepted through this connector. He can add them himself in the app's People section.");
    const r = await app.capture(said, "claude", { full: true });
    const lines = [
      ...r.created.map((t) => `Task added in ${t.area_name}: ${t.title}${t.due ? ` (due ${t.due})` : ""}${t.delegate ? ` (handed to ${t.delegate})` : ""}`),
      ...r.asked.map((a) => `Handed to Hermes: ${a.text}. Its answer will show on the deck.`),
      ...r.did.map((d) => `${d.ok ? "" : "NOT DONE. "}${d.module}: ${d.text}${d.detail ? `\n${d.detail}` : ""}${d.action ? "\n(Needs his tap in the app to send. It has not been sent.)" : ""}`),
    ];
    return text(lines.length ? lines.join("\n") : "Nothing was added. It may not have been clear what he wanted.");
  });

  server.registerTool("whats_next", {
    title: "What's next on the deck",
    description: "The top five things to do now, ranked, and how many items each area has waiting. People shows only as a count.",
    inputSchema: {},
  }, async () => {
    const d = await get("/api/relay/next");
    const next = (d.next as any[]).map((n, i) => `${i + 1}. ${n.title} (${n.area}; ${n.why})`).join("\n") || "Nothing queued.";
    return text(`${next}\n\nWaiting, by area: ${Object.entries(d.needs_you).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  });

  server.registerTool("inbox", {
    title: "Email waiting on him",
    description: "Emails sorted as needing him, ready to hand off, or unplaced: sender, subject and a one-line summary each. No message bodies.",
    inputSchema: {},
  }, async () => {
    const b = await (await app.request("/api/inbox")).json() as any;
    if (!b.connected) return text("Email isn't connected in Life Architect yet.");
    const list = (title: string, items: any[]) => `${title} (${items.length}):\n${items.slice(0, 12).map((m) => `- ${m.from_name}: ${m.subject}${m.summary ? ` — ${m.summary}` : ""}${m.suggest_name ? ` [suggested: hand to ${m.suggest_name}]` : ""}`).join("\n") || "- none"}`;
    return text([list("For him", b.you), list("To hand off", b.handoff), list("Couldn't place", b.unsure)].join("\n\n"));
  });

  server.registerTool("handoff_summary", {
    title: "What was handed off",
    description: "One sentence on which emails were handed off in the last day and what is still waiting.",
    inputSchema: {},
  }, async () => text((await get("/api/relay/handoffs")).text));

  return server;
}

/** Start the connector on its own port. Returns the server so tests can close it. */
export function startMcp(app: Deck, port: number) {
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (code: number, msg: string) => { res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: msg }, id: null })); };
    if (!req.url?.startsWith("/mcp")) return reply(404, "Not found.");
    const token = app.relayToken(), given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      // Behind a public tunnel every caller shares one address, so a lock-out would let a stranger shut Ben out.
      // The token is long and random; a short wait on each wrong try is enough to make guessing pointless.
      await new Promise((ok) => setTimeout(ok, process.env.VITEST ? 0 : 500));
      return reply(401, "Wrong or missing token.");
    }
    if (req.method !== "POST") return reply(405, "Use POST.");
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 200_000) return reply(413, "Too large."); chunks.push(c as Buffer); }
      // One short-lived server per request: no sessions to keep, nothing shared between callers.
      const server = build(app, token);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
    } catch { if (!res.headersSent) reply(400, "Couldn't read that request."); }
  });
  http.listen(port);
  return http;
}
