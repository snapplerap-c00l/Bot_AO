// Cloudflare Worker that lets the website start the "Playtest bot" workflow
// without sending the visitor to GitHub. The GitHub token lives here as a
// secret and never reaches the browser.
//
// Secrets / variables (see WEBSITE.md):
//   GITHUB_TOKEN    secret   fine-grained token, Actions: read and write on this repo only
//   ACCESS_CODE     secret   passcode the site sends so strangers cannot start runs
//   ALLOWED_ORIGIN  var      origin of the site, e.g. https://snapplerap-c00l.github.io

const OWNER = "snapplerap-c00l";
const REPO = "bot_ao";
const WORKFLOW = "playtest.yml";
const REF = "main";

const LIMITS = {
  minutes: [1, 30],
  interval: [5, 120],
  bots: [1, 10],
};

// Only plain characters. No quotes, backticks, dollar signs, spaces or
// semicolons, so the link can never break out of the command that runs it.
const SAFE_URL = /^https:\/\/[A-Za-z0-9\-._~:/?#@!&()*+,=%]+$/;

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-access-code",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env) },
  });
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "allout-playtester-site",
      ...(init.headers || {}),
    },
  });
}

function intIn(value, [min, max]) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

// Constant-time-ish comparison so the code can't be guessed by timing.
function sameCode(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validate(input) {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!SAFE_URL.test(url)) return { error: "Enter a full https:// link with no spaces or quotes." };
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: "That link is not valid." };
  }
  if (host !== "allout.game" && !host.endsWith(".allout.game")) {
    return { error: "Only allout.game links can be tested." };
  }
  const minutes = intIn(input.minutes, LIMITS.minutes);
  const interval = intIn(input.interval, LIMITS.interval);
  const bots = intIn(input.bots, LIMITS.bots);
  if (minutes === null) return { error: `Minutes must be ${LIMITS.minutes[0]} to ${LIMITS.minutes[1]}.` };
  if (interval === null) return { error: `Seconds between shots must be ${LIMITS.interval[0]} to ${LIMITS.interval[1]}.` };
  if (bots === null) return { error: `Bots must be ${LIMITS.bots[0]} to ${LIMITS.bots[1]}.` };
  return { url, minutes, interval, bots };
}

async function activeRun(env) {
  const res = await gh(env, `/actions/workflows/${WORKFLOW}/runs?per_page=5&event=workflow_dispatch`);
  if (!res.ok) return null;
  const data = await res.json();
  return (data.workflow_runs || []).find((r) => r.status === "queued" || r.status === "in_progress" || r.status === "waiting") || null;
}

async function start(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(env, 400, { error: "Send the settings as JSON." });
  }
  const v = validate(body);
  if (v.error) return json(env, 400, { error: v.error });

  if (await activeRun(env)) {
    return json(env, 409, { error: "A run is already going. Wait for it to finish." });
  }

  const res = await gh(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ref: REF,
      inputs: {
        game_url: v.url,
        observe_minutes: String(v.minutes),
        screenshot_interval_seconds: String(v.interval),
        bot_count: String(v.bots),
        job_timeout_minutes: String(v.minutes + 15),
      },
    }),
  });

  if (res.status === 204) return json(env, 200, { ok: true, startedAt: new Date().toISOString() });
  if (res.status === 401 || res.status === 403) return json(env, 502, { error: "GitHub refused the token. Check its Actions permission and expiry." });
  if (res.status === 404) return json(env, 502, { error: "GitHub could not find the workflow. Check the repository and branch names in worker.js." });
  return json(env, 502, { error: `GitHub answered ${res.status}.` });
}

async function status(url, env) {
  const since = Date.parse(url.searchParams.get("since") || "");
  const res = await gh(env, `/actions/workflows/${WORKFLOW}/runs?per_page=5&event=workflow_dispatch`);
  if (!res.ok) return json(env, 502, { error: `GitHub answered ${res.status}.` });
  const data = await res.json();
  const runs = (data.workflow_runs || []).filter((r) => !Number.isFinite(since) || Date.parse(r.created_at) >= since - 15000);
  const run = runs[0];
  if (!run) return json(env, 200, { state: "waiting" });
  return json(env, 200, {
    state: run.status === "completed" ? "done" : run.status === "queued" ? "queued" : "running",
    conclusion: run.conclusion || null,
    runUrl: run.html_url,
    startedAt: run.run_started_at || run.created_at,
    updatedAt: run.updated_at,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (!env.GITHUB_TOKEN || !env.ACCESS_CODE) {
      return json(env, 500, { error: "The proxy is missing its GITHUB_TOKEN or ACCESS_CODE secret." });
    }
    if (!sameCode(request.headers.get("x-access-code") || "", env.ACCESS_CODE)) {
      return json(env, 401, { error: "Wrong access code." });
    }

    if (url.pathname === "/start" && request.method === "POST") return start(request, env);
    if (url.pathname === "/status" && request.method === "GET") return status(url, env);
    return json(env, 404, { error: "Not found." });
  },
};
