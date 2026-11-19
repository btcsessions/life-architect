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
