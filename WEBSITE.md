# Website setup

The site in `docs/` starts the Playtest bot workflow without sending you to GitHub.
A browser can't hold a GitHub token safely, so the page talks to a small proxy
(`worker/worker.js`) that holds the token and starts the workflow for it.

```
docs/index.html  ->  worker/worker.js (Cloudflare Worker)  ->  GitHub Actions
   Start button          holds the token, checks input           runs playtest.yml
```

## 1. Replace the workflow file

Copy `.github/workflows/playtest.yml` from this folder over the one in the repo.
The only change: the game link now reaches the shell through an environment
variable instead of being pasted into the command. Do this before anything else,
because the site lets other people supply a link.

## 2. Make a GitHub token

GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens.

- Repository access: only `snapplerap-c00l/bot_ao`
- Permissions: **Actions: Read and write** (Metadata read is added automatically)
- Pick an expiry and note the date. When the token expires, Start stops working
  until you make a new one and repeat the `wrangler secret put GITHUB_TOKEN` step.

## 3. Deploy the proxy

Needs a free Cloudflare account and Node.

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler secret put GITHUB_TOKEN     # paste the token from step 2
wrangler secret put ACCESS_CODE      # choose any passcode, you will type it on the site
wrangler deploy
```

Wrangler prints the proxy address, for example
`https://allout-playtester.your-name.workers.dev`.

If your site will not be at `https://snapplerap-c00l.github.io`, change
`ALLOWED_ORIGIN` in `worker/wrangler.toml` first, then deploy again.

## 4. Point the site at the proxy

In `docs/index.html`, set `API_URL` near the bottom to the address from step 3.

## 5. Publish the site

Push everything to the repo, then: Settings, Pages, Build and deployment,
Deploy from a branch, branch `main`, folder `/docs`.
The site appears at `https://snapplerap-c00l.github.io/bot_ao/`.

## What the proxy enforces

- Every request needs the access code.
- Only `https://allout.game` links, with plain characters only.
- Minutes 1 to 30, seconds between shots 5 to 120, bots 1 to 10.
- Job timeout is set to minutes + 15.
- A new run is refused while another one is queued or running.

Runs still use your GitHub Actions minutes and your `ANTHROPIC_API_KEY`, so keep
the access code to yourself.
