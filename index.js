import "dotenv/config";
import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";

// ---------- config ----------
const GAME_URL = process.argv[2];
const OBSERVE_MINUTES = Number(process.env.OBSERVE_MINUTES || 5);
const SCREENSHOT_INTERVAL_SECONDS = Number(
  process.env.SCREENSHOT_INTERVAL_SECONDS || 20
);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";
const BOT_COUNT = Math.max(1, Math.min(10, Number(process.env.BOT_COUNT || 1)));
// Capped at 10 - each bot is its own full browser instance, and GitHub's
// free runners only have 2 CPU cores / 7GB RAM, so too many at once will
// just make every bot slower/flakier rather than actually help.

// How many screenshots (max) from each bot get sent to Claude for the
// report - keeps the request size sane when there are many bots.
const MAX_SCREENSHOTS_PER_BOT_FOR_REPORT = 4;

if (!GAME_URL) {
  console.error("Usage: node index.js <allout.game link>");
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join("runs", runId);

// ---------- helpers ----------
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Try a handful of likely selectors/text for a "Play" / "Join" button.
// Falls back to doing nothing if none are found — the page may auto-join.
async function tryClickPlay(page) {
  const candidates = [
    'button:has-text("Play")',
    'button:has-text("Join")',
    'button:has-text("Start")',
    '[data-testid="play-button"]',
    'text=Play',
  ];
  for (const selector of candidates) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.click({ timeout: 2000 });
        console.log(`Clicked play/join button via selector: ${selector}`);
        return true;
      }
    } catch {
      // selector not found or not clickable — try the next one
    }
  }
  console.log("No obvious play/join button found — assuming auto-join.");
  return false;
}

// Extract whatever title/description text is available on the page.
async function extractGameInfo(page) {
  const title = await page.title().catch(() => "");

  const metaDescription = await page
    .locator('meta[name="description"]')
    .first()
    .getAttribute("content")
    .catch(() => null);

  // Grab visible text from likely description containers, plus a fallback
  // of the first ~1500 characters of visible body text.
  const bodyText = await page
    .evaluate(() => document.body?.innerText || "")
    .catch(() => "");

  return {
    title,
    metaDescription: metaDescription || null,
    bodyTextSnippet: bodyText.slice(0, 1500),
  };
}

// Light, harmless exploration so the screenshots capture more than a static
// splash screen: move the mouse around and press a few common game keys.
async function nudgeAround(page) {
  try {
    const viewport = page.viewportSize() || { width: 1280, height: 800 };
    const x = Math.floor(Math.random() * viewport.width);
    const y = Math.floor(Math.random() * viewport.height);
    await page.mouse.move(x, y, { steps: 10 });

    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"];
    const key = keys[Math.floor(Math.random() * keys.length)];
    await page.keyboard.press(key);
  } catch {
    // Non-fatal — the game canvas may not respond to synthetic input,
    // that's fine, we still get screenshots of whatever state it's in.
  }
}

async function observeGame(page, botDir, botLabel) {
  await ensureDir(botDir);
  const screenshots = [];
  const totalMs = OBSERVE_MINUTES * 60 * 1000;
  const intervalMs = SCREENSHOT_INTERVAL_SECONDS * 1000;
  const shots = Math.max(1, Math.floor(totalMs / intervalMs));

  for (let i = 0; i < shots; i++) {
    await nudgeAround(page);
    const filePath = path.join(botDir, `shot-${String(i).padStart(3, "0")}.png`);
    try {
      await page.screenshot({ path: filePath });
      screenshots.push(filePath);
      console.log(`[${botLabel}] Saved screenshot ${i + 1}/${shots}`);
    } catch (err) {
      console.warn(`[${botLabel}] Screenshot ${i + 1} failed: ${err.message}`);
    }
    await sleep(intervalMs);
  }

  return screenshots;
}

// Runs a single bot end-to-end: joins the game, extracts info, observes,
// and closes its browser. Each bot gets its own browser instance so they
// behave like independent players rather than sharing one session.
async function runBot(botIndex) {
  const botLabel = `bot-${botIndex + 1}`;
  const botDir = path.join(outDir, botLabel);

  console.log(`[${botLabel}] Joining: ${GAME_URL}`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    // Game pages like this often keep a live connection (websocket/polling)
    // running forever, so "networkidle" never fires. Wait for the basic
    // page load instead, then give it extra time for assets to render.
    await page.goto(GAME_URL, { waitUntil: "load", timeout: 45000 });
    await sleep(8000);

    const info = await extractGameInfo(page);
    console.log(`[${botLabel}] Extracted page info:`, info.title);

    await tryClickPlay(page);
    await sleep(3000);

    console.log(
      `[${botLabel}] Observing for ~${OBSERVE_MINUTES} minute(s), screenshot every ${SCREENSHOT_INTERVAL_SECONDS}s...`
    );
    const screenshotPaths = await observeGame(page, botDir, botLabel);

    return { botLabel, info, screenshotPaths };
  } finally {
    await browser.close();
  }
}

async function buildReportWithClaude({ url, botResults }) {
  if (!ANTHROPIC_API_KEY) {
    const note =
      "No ANTHROPIC_API_KEY set — skipping AI summary. " +
      "Add your key to .env (or the ANTHROPIC_API_KEY secret) and re-run to " +
      "generate the written report. Raw screenshots and page info have been " +
      "saved for this run.";
    console.log(note);
    return note;
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Use the first bot's page info for the shared description (it's the same
  // game for all of them), and pull a capped number of screenshots from
  // each bot so the request stays a reasonable size.
  const info = botResults[0].info;
  const imageBlocks = [];
  const perBotSections = [];

  for (const { botLabel, screenshotPaths } of botResults) {
    const sampled = screenshotPaths.slice(0, MAX_SCREENSHOTS_PER_BOT_FOR_REPORT);
    perBotSections.push(`${botLabel}: ${sampled.length} screenshots attached`);
    for (const p of sampled) {
      const data = await fs.readFile(p);
      imageBlocks.push({ type: "text", text: `[${botLabel} screenshot]` });
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: data.toString("base64"),
        },
      });
    }
  }

  const multiBot = botResults.length > 1;

  const systemPrompt = `You are an experienced game QA playtester and design
reviewer. You are given a game's title/description text plus timelapse
screenshots taken while ${multiBot ? `${botResults.length} independent bots` : "a bot"}
idled/explored in the game for a few minutes${multiBot ? ", each as a separate simulated player joining at the same time" : ""}.
Write a concise, useful report for the developer covering:

1. Original concept - your best understanding of what the game is trying to be
2. What's working - genuine strengths visible in the screenshots/description
3. Possible bugs or issues - anything that looks broken, stuck, unclear, or
   inconsistent across the screenshots (e.g. UI overlap, nothing changing
   over time when it should, error states, empty/blank screens)${multiBot ? `
4. Multiplayer observations - since screenshots are labeled by bot, note any
   differences between bots (e.g. one stuck while others progress, players
   not seeing each other, desync, lobby/matchmaking issues)` : ""}
${multiBot ? "5" : "4"}. Improvement suggestions - concrete, actionable ideas

Be honest and specific. If the screenshots barely change, say so plainly -
that itself may be a bug (e.g. the game failing to load or respond) rather
than assume it's fine. Format the report in clean markdown with headers.`;

  const userText = `Game URL: ${url}
Page title: ${info.title || "(none found)"}
Meta description: ${info.metaDescription || "(none found)"}

Visible page text (truncated):
${info.bodyTextSnippet || "(none captured)"}

${botResults.length} bot(s) observed this game in parallel, each roughly every
${SCREENSHOT_INTERVAL_SECONDS}s over ~${OBSERVE_MINUTES} minutes:
${perBotSections.join("\n")}

Screenshots below are labeled by which bot took them, in order.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }, ...imageBlocks],
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return text;
}

async function main() {
  console.log(
    `Starting ${BOT_COUNT} bot(s) against: ${GAME_URL}`
  );
  await ensureDir(outDir);

  const botResults = await Promise.all(
    Array.from({ length: BOT_COUNT }, (_, i) => runBot(i))
  );

  console.log("Generating report...");
  const report = await buildReportWithClaude({ url: GAME_URL, botResults });

  const info = botResults[0].info;
  const reportPath = path.join(outDir, "report.md");
  await fs.writeFile(
    reportPath,
    `# Playtest report\n\n**Game:** ${info.title || GAME_URL}\n**URL:** ${GAME_URL}\n**Run:** ${runId}\n**Bots:** ${BOT_COUNT}\n\n---\n\n${report}\n`
  );

  console.log(`\nDone. Report saved to: ${reportPath}`);
}

main().catch((err) => {
  console.error("Bot run failed:", err);
  process.exit(1);
});
