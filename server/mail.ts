// Inbox: reads Gmail (IMAP, app password), sorts it, drafts replies from what you say, hands things off by email.
// Nothing is ever sent without a tap, unless auto hand-off is switched on and a rule has been confirmed three times.
// Gmail itself is left untouched: nothing is marked read, moved or deleted.
import type { Hono } from "hono";
import type { Ctx } from "./app.ts";
import { chat, extractJson } from "./file.ts";

export interface InMail { uid: number; message_id: string; from_name: string; from_addr: string; subject: string; date: string; text: string; references: string; bulk: boolean }
export interface OutMail { to: string; cc?: string; subject: string; text: string; in_reply_to?: string; references?: string }
export interface MailClient { recent: (limit: number) => Promise<InMail[]>; send: (m: OutMail) => Promise<void> }
export type MailFactory = (user: string, password: string, fromName: string) => MailClient;

/** The real thing: Gmail over IMAP and SMTP with an app password. */
export const gmail: MailFactory = (user, password, fromName) => ({
  async recent(limit) {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass: password }, logger: false });
    await client.connect();
    const out: InMail[] = [];
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const since = new Date(Date.now() - 5 * 86_400_000);
        const uids = ((await client.search({ since }, { uid: true })) || []).slice(-limit);
        if (uids.length) {
          for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
            if (!msg.source) continue;
            const m = await simpleParser(msg.source);
            const from = m.from?.value?.[0];
            out.push({
              uid: msg.uid,
              message_id: m.messageId ?? `uid-${msg.uid}`,
              from_name: from?.name || from?.address || "Unknown",
              from_addr: (from?.address ?? "").toLowerCase(),
              subject: m.subject ?? "(no subject)",
              date: (m.date ?? new Date()).toISOString(),
              text: (m.text ?? "").slice(0, 12_000),
              references: [m.references].flat().filter(Boolean).join(" "),
              bulk: Boolean(m.headers.get("list-unsubscribe") || m.headers.get("list-id")) || /bulk|list|junk/i.test(String(m.headers.get("precedence") ?? "")),
            });
          }
        }
      } finally { lock.release(); }
    } finally { await client.logout().catch(() => {}); }
    return out;
  },
  async send(m) {
    const { createTransport } = await import("nodemailer");
    const t = createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass: password } });
    await t.sendMail({ from: fromName ? { name: fromName, address: user } : user, to: m.to, cc: m.cc || undefined, subject: m.subject, text: m.text, inReplyTo: m.in_reply_to, references: m.references });
  },
});

const BUCKETS = ["you", "handoff", "unsure", "fyi"] as const;
type Bucket = (typeof BUCKETS)[number];
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const emails = (s: unknown): string[] | null => {
  const list = String(s ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  return list.every((x) => EMAIL.test(x)) ? list : null;
};
const AUTOMATED = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer|newsletter|news|updates?|digest|billing|receipts?|info|hello|team|marketing|support)@/i;
const re = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

const TRIAGE_RULES = `You sort one person's email. For each numbered message reply with a JSON array of objects, same order:
{"n": number, "bucket": "you" | "handoff" | "unsure" | "fyi", "summary": one short plain sentence saying what they want, "to": name of the person it should be handed to or null}
"you": only the owner can answer. "handoff": someone on the list of known hand-offs clearly should take it; name them in "to". "fyi": newsletters, receipts, notifications, nothing to do. "unsure": anything else. Never invent a name that isn't on the list.`;
const DRAFT_RULES = `Write the body of an email reply for the owner, from what they said they want to say. Plain text, short, in their voice, first person. No subject line, no placeholders, no sign-off name unless they gave one. Reply with ONLY the email body.`;

export function mountMail(app: Hono, ctx: Ctx, factory: MailFactory = gmail) {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, from_name TEXT NOT NULL, from_addr TEXT NOT NULL,
      subject TEXT NOT NULL, date TEXT NOT NULL, body TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '',
      bucket TEXT NOT NULL DEFAULT 'unsure', summary TEXT, suggest_name TEXT, suggest_email TEXT, sorted_by TEXT NOT NULL DEFAULT 'rules',
      status TEXT NOT NULL DEFAULT 'new', handled_at TEXT, handled_how TEXT
    );
    CREATE TABLE IF NOT EXISTS mail_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS mail_sent (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, mail_id INTEGER, to_addr TEXT NOT NULL, cc TEXT, subject TEXT NOT NULL, who TEXT, auto INTEGER NOT NULL DEFAULT 0
    );
  `);
  const bad = (c: any, error: string, status = 400) => c.json({ error }, status);
  const now = () => ctx.now().toISOString();
  const client = (): MailClient | null => {
    const user = ctx.setting("mail_user"), pass = ctx.setting("mail_password").replace(/\s+/g, "");
    return user && pass ? factory(user, pass, ctx.setting("mail_from_name")) : null;
  };
  const get = (id: number) => db.prepare("SELECT * FROM mail WHERE id = ?").get(id) as any;
  const delegates = () => db.prepare("SELECT name, email, SUM(uses) AS uses FROM mail_rules GROUP BY lower(email) ORDER BY uses DESC").all() as Array<{ name: string; email: string; uses: number }>;
  const brief = (m: any) => ({ id: m.id, from_name: m.from_name, from_addr: m.from_addr, subject: m.subject, date: m.date, summary: m.summary, bucket: m.bucket, suggest_name: m.suggest_name, suggest_email: m.suggest_email, status: m.status, handled_how: m.handled_how, sorted_by: m.sorted_by });

  async function handOff(m: any, name: string, email: string, note: string, auto: boolean, mc: MailClient) {
    const text = `${note ? `${note}\n\n` : `${name.split(" ")[0]}, can you take this one?\n\n`}---------- Forwarded message ----------\nFrom: ${m.from_name} <${m.from_addr}>\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`;
    const subject = /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`;
    await mc.send({ to: email, subject, text });
    db.prepare("INSERT INTO mail_sent (ts, kind, mail_id, to_addr, subject, who, auto) VALUES (?, 'handoff', ?, ?, ?, ?, ?)").run(now(), m.id, email, subject, name, auto ? 1 : 0);
    db.prepare("UPDATE mail SET status = 'handled', bucket = 'handoff', handled_at = ?, handled_how = ? WHERE id = ?").run(now(), `Handed to ${name}${auto ? " automatically" : ""}`, m.id);
    db.prepare("INSERT INTO tasks (area_id, title, note, importance, delegate, source, created_at) VALUES ('inbox', ?, ?, 2, ?, 'inbox', ?)")
      .run(`${m.subject} (from ${m.from_name})`.slice(0, 200), m.summary, name, now());
  }

  /** Pull new mail and sort it. Returns how many were new. */
  async function sync(): Promise<{ added: number; auto: number }> {
    const mc = client();
    if (!mc) throw new Error("Add your Gmail address and app password in Settings first.");
    const fresh: any[] = [];
    for (const m of await mc.recent(40)) {
      const r = db.prepare("INSERT OR IGNORE INTO mail (message_id, from_name, from_addr, subject, date, body, refs) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(m.message_id, m.from_name.slice(0, 120), m.from_addr.slice(0, 200), m.subject.slice(0, 300), m.date, m.text, m.references.slice(0, 2000));
      if (r.changes) fresh.push({ ...get(Number(r.lastInsertRowid)), bulk: m.bulk });
    }
    const set = db.prepare("UPDATE mail SET bucket = ?, summary = ?, suggest_name = ?, suggest_email = ?, sorted_by = ? WHERE id = ?");
    const me = ctx.setting("mail_user").toLowerCase();
    const left: any[] = [];
    for (const m of fresh) {
      const rule = db.prepare("SELECT * FROM mail_rules WHERE sender = ?").get(m.from_addr) as any;
      if (m.from_addr === me) set.run("fyi", "Sent by you.", null, null, "rules", m.id);
      else if (rule) set.run("handoff", `Usually goes to ${rule.name}.`, rule.name, rule.email, "rule", m.id);
      else if (m.bulk || AUTOMATED.test(m.from_addr)) set.run("fyi", null, null, null, "rules", m.id);
      else left.push(m);
    }
    const cfg = ctx.modelFor("llm");
    const known = delegates();
    for (let i = 0; cfg && i < left.length; i += 10) {
      const batch = left.slice(i, i + 10);
      try {
        const answer = extractJson(await chat(cfg, [
          { role: "system", content: `${TRIAGE_RULES}\nKnown hand-offs: ${JSON.stringify(known.map((d) => d.name))}` },
          { role: "user", content: batch.map((m, n) => `#${n + 1}\nFrom: ${m.from_name} <${m.from_addr}>\nSubject: ${m.subject}\n${m.body.slice(0, 1500)}`).join("\n\n") },
        ], 90_000)) as any[];
        for (const a of Array.isArray(answer) ? answer : []) {
          const m = batch[Number(a?.n) - 1];
          if (!m || !BUCKETS.includes(a.bucket)) continue;
          const d = a.bucket === "handoff" ? known.find((x) => x.name.toLowerCase() === String(a.to ?? "").toLowerCase()) : undefined;
          // A hand-off the model can't pin on a known person is only a maybe.
          const bucket: Bucket = a.bucket === "handoff" && !d ? "unsure" : a.bucket;
          set.run(bucket, typeof a.summary === "string" ? a.summary.slice(0, 240) : null, d?.name ?? null, d?.email ?? null, "model", m.id);
        }
      } catch { /* leave them in "can't place" */ }
    }
    let auto = 0;
    if (ctx.setting("mail_auto_delegate") === "on") {
      for (const f of fresh) {
        const m = get(f.id);
        const rule = db.prepare("SELECT * FROM mail_rules WHERE sender = ?").get(m.from_addr) as any;
        if (m.sorted_by !== "rule" || !rule || rule.uses < 3) continue;
        try { await handOff(m, rule.name, rule.email, "", true, mc); auto++; } catch { /* stays in the list for a tap */ }
      }
    }
    ctx.secret.set("mail_synced", now());
    return { added: fresh.length, auto };
  }

  app.get("/api/inbox", (c) => {
    const open = db.prepare("SELECT * FROM mail WHERE status = 'new' ORDER BY date DESC LIMIT 200").all() as any[];
    const group = (b: Bucket) => open.filter((m) => m.bucket === b).map(brief);
    const day = ctx.day();
    const handled = (db.prepare("SELECT * FROM mail WHERE status = 'handled' AND handled_at >= ? ORDER BY handled_at DESC LIMIT 50").all(new Date(ctx.now().getTime() - 86_400_000).toISOString()) as any[]).map(brief);
    return c.json({
      connected: Boolean(client()), user: ctx.setting("mail_user"), synced: ctx.secret.get("mail_synced"), today: day,
      has_model: Boolean(ctx.modelFor("llm")), auto: ctx.setting("mail_auto_delegate") === "on",
      you: group("you"), unsure: group("unsure"), handoff: group("handoff"), fyi: group("fyi"), handled, delegates: delegates(),
    });
  });

  app.post("/api/inbox/sync", async (c) => {
    try { return c.json(await sync()); }
    catch (e) {
      const msg = (e as Error).message ?? "";
      if (/Settings first/.test(msg)) return bad(c, msg);
      return bad(c, /auth|credential|password|login/i.test(msg) ? "Gmail refused the sign-in. Check the address and app password in Settings." : "Couldn't reach Gmail just now. Try again in a minute.", 502);
    }
  });

  app.get("/api/inbox/:id", (c) => {
    const m = get(Number(c.req.param("id")));
    return m ? c.json({ ...brief(m), body: m.body }) : bad(c, "No such message.", 404);
  });

  // Turn what was said into a reply. Nothing is sent here.
  app.post("/api/inbox/:id/draft", async (c) => {
    const m = get(Number(c.req.param("id")));
    if (!m) return bad(c, "No such message.", 404);
    const say = String(((await c.req.json().catch(() => ({}))) as any).say ?? "").trim();
    if (!say) return bad(c, "Say what you want to tell them first.");
    const cfg = ctx.modelFor("llm");
    if (!cfg) return c.json({ subject: re(m.subject), text: say, via: "your words" });
    try {
      const text = await chat(cfg, [{ role: "system", content: DRAFT_RULES }, { role: "user", content: `Their email, from ${m.from_name}:\nSubject: ${m.subject}\n${m.body.slice(0, 4000)}\n\nWhat the owner wants to say:\n${say}` }], 90_000);
      return c.json({ subject: re(m.subject), text, via: "model" });
    } catch { return c.json({ subject: re(m.subject), text: say, via: "your words", note: "The model didn't answer, so this is exactly what you said." }); }
  });

  // Send a reply. Only ever called from the Send button.
  app.post("/api/inbox/:id/send", async (c) => {
    const m = get(Number(c.req.param("id")));
    if (!m) return bad(c, "No such message.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const text = String(b.text ?? "").trim();
    if (!text) return bad(c, "There's nothing to send yet.");
    const cc = emails(b.cc), fwd = emails(b.forward_to);
    if (!cc || !fwd) return bad(c, "One of those addresses doesn't look right.");
    const mc = client();
    if (!mc) return bad(c, "Add your Gmail address and app password in Settings first.");
    try {
      await mc.send({ to: m.from_addr, cc: cc.join(", ") || undefined, subject: re(m.subject), text, in_reply_to: m.message_id, references: `${m.refs} ${m.message_id}`.trim() });
      db.prepare("INSERT INTO mail_sent (ts, kind, mail_id, to_addr, cc, subject) VALUES (?, 'reply', ?, ?, ?, ?)").run(now(), m.id, m.from_addr, cc.join(", ") || null, re(m.subject));
      if (fwd.length) {
        const subject = `Fwd: ${m.subject}`;
        await mc.send({ to: fwd.join(", "), subject, text: `For your records. My reply:\n\n${text}\n\n---------- Original message ----------\nFrom: ${m.from_name} <${m.from_addr}>\nSubject: ${m.subject}\n\n${m.body}` });
        db.prepare("INSERT INTO mail_sent (ts, kind, mail_id, to_addr, subject) VALUES (?, 'forward', ?, ?, ?)").run(now(), m.id, fwd.join(", "), subject);
      }
    } catch { return bad(c, "Gmail didn't accept that. Nothing was marked as sent; try again.", 502); }
    db.prepare("UPDATE mail SET status = 'handled', handled_at = ?, handled_how = 'Replied' WHERE id = ?").run(now(), m.id);
    return c.json({ sent: true });
  });

  // Hand it to someone by email, and optionally remember that this sender goes to them.
  app.post("/api/inbox/:id/handoff", async (c) => {
    const m = get(Number(c.req.param("id")));
    if (!m) return bad(c, "No such message.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    const name = String(b.name ?? "").trim().slice(0, 80), email = String(b.email ?? "").trim().toLowerCase();
    if (!name || !EMAIL.test(email)) return bad(c, "Give a name and an email address to hand it to.");
    const mc = client();
    if (!mc) return bad(c, "Add your Gmail address and app password in Settings first.");
    try { await handOff(m, name, email, String(b.note ?? "").trim().slice(0, 2000), false, mc); }
    catch { return bad(c, "Gmail didn't accept that. Nothing was handed off; try again.", 502); }
    if (b.remember !== false) {
      db.prepare("INSERT INTO mail_rules (sender, name, email) VALUES (?, ?, ?) ON CONFLICT(sender) DO UPDATE SET uses = CASE WHEN lower(email) = lower(excluded.email) THEN uses + 1 ELSE 1 END, name = excluded.name, email = excluded.email")
        .run(m.from_addr, name, email);
    }
    return c.json({ sent: true });
  });

  // Move it, or clear it without sending anything.
  app.patch("/api/inbox/:id", async (c) => {
    const m = get(Number(c.req.param("id")));
    if (!m) return bad(c, "No such message.", 404);
    const b = (await c.req.json().catch(() => ({}))) as any;
    if (BUCKETS.includes(b.bucket)) db.prepare("UPDATE mail SET bucket = ?, sorted_by = 'you' WHERE id = ?").run(b.bucket, m.id);
    if (b.done === true) db.prepare("UPDATE mail SET status = 'handled', handled_at = ?, handled_how = 'Cleared' WHERE id = ?").run(now(), m.id);
    if (b.done === false) db.prepare("UPDATE mail SET status = 'new', handled_at = NULL, handled_how = NULL WHERE id = ?").run(m.id);
    if (b.task === true) {
      await ctx.db.prepare("INSERT INTO tasks (area_id, title, note, importance, source, created_at) VALUES ('inbox', ?, ?, 2, 'inbox', ?)").run(`Reply to ${m.from_name}: ${m.subject}`.slice(0, 200), m.summary, now());
    }
    return c.json(brief(get(m.id)));
  });

  app.get("/api/inbox-rules", (c) => c.json({ rules: db.prepare("SELECT * FROM mail_rules ORDER BY uses DESC, sender").all() }));
  app.delete("/api/inbox-rules/:id", (c) => c.json({ removed: db.prepare("DELETE FROM mail_rules WHERE id = ?").run(Number(c.req.param("id"))).changes }));

  // What went out on your behalf in the last day, for the hand-off summary.
  const summary = () => {
    const since = new Date(ctx.now().getTime() - 86_400_000).toISOString();
    const sent = db.prepare("SELECT * FROM mail_sent WHERE ts >= ? ORDER BY ts DESC").all(since) as any[];
    const waiting = (db.prepare("SELECT bucket, COUNT(*) AS n FROM mail WHERE status = 'new' AND bucket != 'fyi' GROUP BY bucket").all() as any[]);
    const n = (b: string) => waiting.find((w) => w.bucket === b)?.n ?? 0;
    const hand = sent.filter((s) => s.kind === "handoff");
    const lines = [
      hand.length ? `Handed off: ${hand.map((s) => `"${s.subject.replace(/^Fwd: /, "")}" to ${s.who}${s.auto ? " (automatic)" : ""}`).join("; ")}.` : "Nothing handed off in the last day.",
      ((n) => `${n} ${n === 1 ? "reply" : "replies"} sent.`)(sent.filter((s) => s.kind === "reply").length),
      `Waiting: ${n("you")} for you, ${n("handoff")} to hand off, ${n("unsure")} it couldn't place.`,
    ];
    return { sent, text: lines.join(" ") };
  };
  app.get("/api/inbox-summary", (c) => c.json(summary()));

  // The same summary for Hermes to read out. Token-guarded by the relay. Subjects and names only, no bodies.
  app.get("/api/relay/handoffs", (c) => c.json({ text: summary().text }));

  /** For the deck: how many emails are waiting on him. */
  return { waiting: () => (db.prepare("SELECT COUNT(*) AS n FROM mail WHERE status = 'new' AND bucket IN ('you', 'handoff', 'unsure')").get() as { n: number }).n, sync, connected: () => Boolean(client()) };
}
