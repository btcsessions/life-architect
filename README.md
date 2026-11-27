# Life Architect

One deck for everything on your plate, served from your Umbrel and reached over Tailscale.

## What's in it

- **Next up**: one ranked list from importance, due date and time needed. "Done, what's next?" advances it.
- **Quick-add**: type, talk, or attach. "Finish the outline by Thursday, important, 90 minutes. Ask Nathan to redo
  the thumbnail." is split into tasks and filed. Voice uses the Whisper service bundled with the Umbrel app.
- **The main screen drives everything.** Besides tasks, quick-add can hand an instruction to Hermes, add a trip or a
  booking, log spending, mark or change a task, and act on an email it finds by sender or subject (draft a reply,
  hand it off, make a task, give it to Hermes). Email is drafted and waits for a Send tap. Start with "People:" to
  drop a note straight into People without any model reading it. The module screens are for detail and control.
- **Modules**: Work, Travel & Speaking, Family, Health, Inbox, Hobbies & Learning, Build & Automate, Money, People.
- **Work**: the tutorial pipeline (ideas you can reorder, then Outline, Record, Line edit, YouTube prep, Live), each
  with notes, links and its outline, plus Bitcast prep from a rundown PDF with intro-hook takes. Line edit, YouTube
  prep and Bitcast prep are Hermes's own skills, triggered from here.
- **Travel**: trips with flights, stay, costs, documents and a schedule you can send to Google Calendar.
- **Inbox**: reads Gmail with an app password, sorts it (for you / hand off / couldn't place / nothing to do),
  writes replies from what you say, and hands mail to people by email. Nothing is sent without a tap. It learns
  who gets what; automatic hand-off is off until you switch it on in Settings, and then only for a sender you've
  handed to the same person three times. Gmail itself is never changed.
- **Money** (PIN): import bank and card statements (PDF or CSV; PDFs are read on the Umbrel and shown for checking first), see where it goes, drill into categories, spot subscriptions.
  The Money model only ever sees merchant names.
  Money moving between your own accounts (chequing to savings, a card payment) is matched and counted as neither
  spending nor income. Bitcoin wallets can be added by public key (xpub, ypub, zpub): balances at today's price,
  single-key or multisig descriptor; each receipt valued in CAD on the day it confirmed, and moves between your own wallets shown as transfers.
  Addresses are only sent to the address server you set, which should be your own node.
- **People** (PIN): guidance first. The main page is an overall read, what to do now, and one box to ask a question
  or drop in context (text, voice, pasted chats, screenshots, PDFs). Below it, each relationship or scenario is one
  row that opens to its own guidance, with "Go deeper" for a fuller read. The detailed record (notes that can't be
  rewritten, quotes, details, open questions, readings, the research library) sits behind **Records** and fills
  itself in from what you tell it. It uses only its own model. The deck and the relay show "People: something due"
  and nothing else. Hermes can reach it from Telegram with a separate People token (see docs/hermes.md).
- **Noticed** (under Build & Automate): suggestions when you repeat something often enough to automate.
- **Claude from your phone**: a connector on port 4601 lets Claude add and do things by voice from anywhere.
  See [docs/claude-connector.md](docs/claude-connector.md).
- **Relay**: lets Hermes add to the deck and read out what's next. See [docs/hermes.md](docs/hermes.md).

## Install and update

Add the community app store `https://github.com/btcsessions/umbrel-apps` in the Umbrel App Store, install
Life Architect, and use **Update** there when a new version shows. Open `http://<umbrel-tailscale-ip>:4600`.

Data lives in the app's data folder on the Umbrel: `life.db` (deck, travel, inbox, money), `people.db` (People,
kept separate), and `files/`. Back those up.

## Settings to fill in

| What | Where | Notes |
| --- | --- | --- |
| Deck model | Settings › Model | Hermes: `http://hermes-agent_web_1:8642/v1`, pick the model from the list |
| Money model | Settings › Money model | Its own model; without one, sorting uses rules |
| People model | Settings › People model | Its own model; never falls back to the deck model |
| Gmail | Settings › Gmail | Address, app password, your name on replies |
| Relay token | Settings › Relay | Shown once; give it to Hermes |
| PINs | Open Money / People | Set on first open. Locks after 15 idle minutes |

Keys and passwords are saved on the Umbrel and never shown again.

## Things to know

- **No login on the deck itself.** Anyone who can reach the port can use it. Keep it on Tailscale. Money and
  People have their own PINs on top.
- **Live recording needs HTTPS.** On plain `http://` the mic hands off to the device's recorder (more taps).
- **Without a model**, filing and email sorting use simple rules, and email replies go out in your own words.
- **People privacy.** PIN-locked on the server, separate database, never filed by quick-add, never returned by the
  relay. The database is not encrypted on disk; someone with access to the Umbrel's files could read it.

## Develop

```sh
npm install
npm run dev:server   # API on :4600
npm run dev:web      # web on :5173
npm test
```

Pushing to `main` builds `ghcr.io/btcsessions/life-architect:<version in package.json>`.

**Releasing:** bump `version` in `package.json` and rewrite `release-notes.txt` (one paragraph), then push to `main`.
The workflow builds the image, then updates the listing in `btcsessions/umbrel-apps` (version, image tag, release notes)
using the `STORE_TOKEN` secret, so **Update** appears on the Umbrel. No one needs to touch the store repo by hand.
