# Connecting Hermes

Hermes runs on the same Umbrel, so it reaches Life Architect at:

    http://btcsessions-life-architect_web_1:4600

Create a relay token in Life Architect: **Settings › Relay › Create token**. It is shown once. Paste it into
Hermes yourself; don't send it through a chat.

Every call sends the header `Authorization: Bearer <token>`.

## What Hermes can do

| Call | What it does |
| --- | --- |
| `POST /api/relay/add` with `{"text": "...", "source": "telegram"}` | Files what you said into the deck. Returns what was added. |
| `GET /api/relay/next` | The top five things to do, and a count per area. People appears only as a count. |
| `GET /api/relay/handoffs` | One sentence on what email was handed off in the last day and what's waiting. |
| `POST /api/people-drop` with `{"text": "...", "source": "hermes"}` or `{"items": ["...", "..."]}` | Drops notes into People's "Handed over" list for you to file. Write-only: it returns a count and nothing else. |

`source` is a label you choose (`claude`, `chatgpt`, `telegram`), shown beside the item in "Added elsewhere".

## The Work area: tutorials and Bitcast

| Call | What it does |
| --- | --- |
| `POST /api/relay/tutorials` with `{"source": "Hermes list", "items": [{"title": "...", "notes": "...", "links": [{"label": "...", "url": "..."}]}]}` | Adds tutorial ideas to the Up next list. Titles already there are skipped, so it can be re-run. |
| `GET /api/relay/tutorials` | The open tutorials with their stage. |
| `POST /api/relay/tutorial-update` with `{"title": "...", "stage": "youtube_prep", "note": "...", "link": "https://..."}` | Reports progress on one tutorial: moves its stage, adds a line to its history, attaches a link. Optional `"outline_url"`, `"folder"` (footage folder in Movies on the M5 Max) and `"video"` (YouTube ID or link) fill those in. Stages: `idea`, `outline`, `record`, `line_edit`, `youtube_prep`, `live`. |

Life Architect triggers Hermes's own skills by sending the same words you would:

- **Bitcast prep**: the API can't carry attachments, so the app tells Hermes where to download the rundown PDF
  (`/api/work/handover/<long random token>.pdf` on this app) and asks for the intro between `<<<INTRO` and `INTRO>>>`.
- **YouTube prep**: `YouTube prep for "<title>"`, with the video ID when it's set. Replies are resent with the whole
  conversation, because the API keeps no memory between calls.
- **Line edit**: `Line edit <footage folder or title>`. The app only starts it; questions and the finished link still
  come on Telegram, and Hermes is asked to call `tutorial-update` when it's done.

## A skill to give Hermes

Paste this into Hermes as a skill or standing instruction, with the token filled in on the Umbrel:

> You can reach my Life Architect deck at http://btcsessions-life-architect_web_1:4600 with the header
> `Authorization: Bearer <token>`.
> - When I say "add", "remind me", "put on my list" or describe something I need to do, POST it word for word to
>   `/api/relay/add` as `{"text": ..., "source": <where I said it>}` and tell me what it filed.
> - When I ask "what's next" or "what's on my plate", GET `/api/relay/next` and read it back briefly.
> - When I ask what was handed off, GET `/api/relay/handoffs`.
> - When I ask you to hand my notes about a person or a relationship to Life Architect, POST them to
>   `/api/people-drop`. Only do this when I'm talking to you through your private model, never when the request
>   comes from Claude or ChatGPT. You cannot read anything back from People.

## Moving existing People notes over

`/api/people-drop` takes a list. Each item is either plain text (lands in an unsorted pile) or an object that names
the person, which is filed straight onto that person and creates them if they're new:

```json
{"source": "hermes", "items": [
  {"person": "Full Name", "date": "2026-09-02", "text": "What happened, with their exact words in \"quotes\"."},
  {"person": "Full Name", "type": "fact", "label": "Does", "text": "Runs a conference"},
  {"person": "Full Name", "type": "question", "text": "An open question between us"},
  {"person": "Full Name", "type": "goal", "text": "What I want this relationship to become"},
  {"person": "Full Name", "type": "met", "text": "How we met"},
  "Anything that isn't clearly about one person"
]}
```

`type` defaults to a dated note. Up to 2000 items per call. Sending the same item twice files it once, so a dump
can be re-run safely. The answer is counts only. Nothing is deleted from Hermes or Telegram.

In Life Architect, people who arrive this way show under **People › Handed over · not set up yet**. Open one to say
what you want the relationship to be, merge it into another entry ("Dana" and "Dana Lee"), rename it, or remove it.

**Finding things.** The app never asks Ben for a video ID, footage folder or outline link. Line edit and YouTube prep tell Hermes
to find them as usual, and "Check where it stands" / "Find it in Drive" ask Hermes to look (Drive, Movies on the M5 Max,
YouTube) without starting any skill. Hermes ends those replies with a `<<<FOUND … FOUND>>>` block of `key: value` lines
(`stage`, `outline`, `folder`, `video`, `link: label | url`, `note`), which the app reads and strips before showing the reply.
Stages found this way only ever move a tutorial forward.

**YouTube prep** (`server/prep.ts`). The app sends `YouTube prep for "<title>". …` and Hermes runs its usual skill (10–20 min).
Hermes reports the result by `POST /api/relay/youtube-prep` with `{"tutorial": "<title>", "action": "prep" | "title" |
"thumbnail" | "social" | "schedule" | "other", "status": "done" | "working" | "failed", …fields}` and ends its reply with the
same JSON between `<<<PREP` and `PREP>>>`. Fields: `video_id, title, title_candidates[{title, score}], description, tags,
priority_tags, chapters, cards[{time, teaser, what, link}], sponsor_reads[{start, end, sponsor, link}], pinned_comment,
end_screen, thumbnail{set, source, note}, socials[{id, platform, label, text, state}], privacy, publish_at, playlists, flags,
studio_todos, prep_doc_path, note`. While something is pending the app sends a status check every 5 minutes (after 12 min
for a prep, 6 for scheduling, 4 for edits); a check settles it only when `status` is `done` or `failed`. Thumbnails are handed
over as `GET /api/work/thumb/<random token>.jpg` on the app's internal address. Scheduling sends an ISO time with offset;
Hermes confirms on Telegram and Ben signs the Nostr note in Amber. Once `publish_at` passes, the tutorial moves to Live.

