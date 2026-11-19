# Life Architect

One deck for everything on your plate, served from your Umbrel and reached over Tailscale.
This is **Phase 1** of the build plan: the deck and quick-add.

## What works now

- **Next up**: one ranked list from three things you give each task: importance, due date, time needed.
  "Done, what's next?" advances it; "Not today" hides a task until tomorrow.
- **Modules**: Work, Travel & Speaking, Family, Health, Inbox, Hobbies & Learning, Build & Automate, Money, People.
  Collapsed, with a badge for what needs you. Click to expand, click a task to change its details.
- **Quick-add**: type (or speak, once speech-to-text is set up) something like
  *"Finish the YubiKey outline by Thursday, important, 90 minutes. Ask Nathan to redo the thumbnail."*
  It is split into tasks and filed. Links you include are kept on the task.
- **Settings** (top right): enter the address, model name and key for the model that files quick-adds, and for
  speech-to-text. Keys are saved on the Umbrel and never shown again. "Save and test" checks the connection.
- **People** is a sealed placeholder: the deck never shows its task text, and quick-add never files into it.

## Not built yet

File upload in quick-add, the Hermes relay (Phase 2), Inbox (3), Travel (4), the Money dashboard and PIN (5),
People (6), automation suggestions (7).

## Install on the Umbrel

```sh
git clone https://github.com/btcsessions/life-architect.git
cd life-architect
cp .env.example .env      # optional: edit to add a model or speech-to-text
docker compose up -d --build
```

Open `http://<umbrel-tailscale-ip>:4600`.

Update later with:

```sh
git pull && docker compose up -d --build
```

Your data lives in `./data/life.db`. Back that file up; nothing else needs keeping.

## Things to know

- **No login yet.** Anyone who can reach the port can use the deck. Keep it on Tailscale: set `LA_BIND` in `.env`
  to the Umbrel's Tailscale address so it does not listen on the home network.
- **Voice.** The Umbrel app bundles a Whisper speech-to-text service, so the mic works after install (the first
  start downloads its model, which takes a few minutes). Tap the mic, talk, tap again: it is written down and filed.
- **Live recording needs HTTPS.** Browsers block the microphone on plain `http://` addresses. Without HTTPS the mic
  button hands off to the device's own recorder instead, which works but takes more taps. Serving the deck through
  Tailscale HTTPS (`tailscale serve`) gives one-tap recording and lets you install it as an app on your phone.
- **Without a model, filing uses simple rules.** It recognises dates ("by Friday", "tomorrow"), time ("90 minutes"),
  importance ("important", "low priority"), hand-offs ("ask Nathan to…") and a few topic words. Set `LLM_URL` and
  `LLM_MODEL` to have a model do the filing; if the model fails, it falls back to the rules.
- **How ranking works** is in `server/rank.ts`: importance counts most, then how close the due date is; quick tasks
  get a small lift, and long tasks due within two days get one too.

## Develop

```sh
npm install
npm run dev:server   # API on :4600
npm run dev:web      # web app with hot reload, proxies /api
npm test
```

Stack: Hono, React, SQLite. The look is the "Sessions" theme from Sessions Wallet.
