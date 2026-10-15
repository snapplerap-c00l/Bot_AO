# allout.game playtester bot

Joins an allout.game link, watches the game for a few minutes (taking periodic
screenshots and light input), then uses Claude to write a bug/improvement
report for the developer.

## What it does

1. Opens the game URL in a headless browser
2. Grabs the page title / description / visible text
3. Tries to click a "Play"/"Join" button if one exists
4. Takes a screenshot every N seconds for a few minutes, nudging the mouse/
   keyboard lightly so the screenshots show more than a static splash screen
5. Sends the description + screenshots to Claude, which writes a markdown
   report covering: concept summary, what's working, possible bugs, and
   improvement suggestions
6. Saves everything (screenshots + report) under `runs/<timestamp>/`
7. Learns: updates a per-game memory file in `memory/` (see below)

## AI play

With an `ANTHROPIC_API_KEY` set, Claude plays the game instead of random key
mashing. Every few seconds the bot sends Claude a screenshot, Claude picks one
action (hold a key, click, move the mouse, or wait), and the bot carries it out.
The action log is included in the report, so it can say what was actually tried
and where the bot got stuck.

The code enforces the limits, not the model: only a short list of game keys is
allowed (no Enter, no typing), clicks are refused on anything labelled like a
friend/invite/party, chat, shop, login, share or external link, and holds are
capped at 2.5s. Refused actions show up in the log.

Settings (see `env.example`): `AI_PLAY=0` turns it off, `AI_STEP_SECONDS`,
`AI_MAX_STEPS` (each step is one API call, so this caps cost per bot), and
`AI_PLAY_MODEL` (a cheaper model than the one writing the report).

## How it learns

The bot keeps one small JSON file per game in `memory/` (override with
`MEMORY_DIR`). It holds a short profile of the game, a log of recent runs, a
list of tracked issues (open / fixed / unclear, with how many runs each was
seen in), notes on what helps the bot, and things to check next time.

- **Before the report:** the memory is given to Claude, so the report gets a
  "Compared to previous runs" section: what's new, what's still happening, and
  what looks fixed.
- **After the report:** a second Claude call updates the memory from the new
  report. Counters and dates are handled in code, and issues are never
  silently dropped.
- **On GitHub Actions:** the workflow commits `memory/` back to the repo after
  each run, so the next run starts with it. Runs are queued so they never
  overwrite each other's memory.

This is memory, not model training: Claude itself doesn't change, but each run
gets better context than the last. To reset what the bot knows about a game,
delete its file in `memory/`. Without an `ANTHROPIC_API_KEY` the memory is
neither read for a report nor updated.

## Setup (on a server/VPS — recommended)

This needs a real Chromium binary, which is why it's meant to run on a small
always-on Linux box (a cheap VPS, Railway, Render, a Raspberry Pi, etc.) —
not directly on Android. You can still trigger it and check results from
your phone (see "Running it from your phone" below).

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
```

## Usage

```bash
node index.js "https://allout.game/games/6a37845ff55e4a66bc131e3a/Fishermon-after-dawn"
```

Optional settings in `.env`:
- `OBSERVE_MINUTES` — how long to watch the game (default 5)
- `SCREENSHOT_INTERVAL_SECONDS` — how often to screenshot (default 20)

Without an `ANTHROPIC_API_KEY` set, the bot still joins, screenshots, and
saves everything — it just skips the written report until you add a key.

## Running it on GitHub Actions (free, no server needed)

This repo includes `.github/workflows/playtest.yml`, which runs the bot
on demand — no VPS required, and you can trigger it straight from the
**GitHub mobile app**.

### One-time setup

1. Push this folder to a new GitHub repo (public repos get free Actions
   minutes; private repos get 2,000 free min/month, plenty for this).
2. In the repo: **Settings → Secrets and variables → Actions → New repository
   secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key (skip this if you don't have one yet — the bot will
     still run and save screenshots, just without the written report)

### Running it (from your phone)

1. Open the repo in the **GitHub app**
2. Go to the **Actions** tab → **Playtest bot** workflow
3. Tap **Run workflow**, paste in the game URL, adjust minutes/interval if
   you want, and run it
4. When it finishes, the report is posted straight into the run's **summary**
   (viewable in the app, no download needed) — screenshots are attached as a
   downloadable artifact if you want those too

No SSH, no server maintenance, and it only runs (and only costs Action
minutes) when you actually trigger it.

## Notes

- Getting Chromium running is the main blocker on Android/Termux — official
  Playwright browser binaries aren't built for that environment, so a
  server is the reliable path.
- The "Play"/"Join" button detection uses a few common selectors/text
  matches. If your game's UI uses something different, tell me what the
  button looks like/says and I'll adjust `tryClickPlay`.
- All bot interaction is passive (mouse moves, arrow keys) — it doesn't try
  to log in as a real user or take actions on anyone's behalf beyond
  observing, to stay clear of anything that could look like account
  automation.
