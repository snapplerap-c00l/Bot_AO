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

// Closes a "Play on Phone" (QR code) modal if one is open, so it doesn't
// block later attempts to find the real "Instant Play" button underneath.
async function closePhoneModalIfOpen(page) {
  try {
    const modalVisible = await page
      .locator('text=Play on Phone')
      .first()
      .isVisible({ timeout: 500 });
    if (modalVisible) {
      console.log("Closing 'Play on Phone' modal to reveal the real join button.");
      // Try a close (X) button first, fall back to pressing Escape.
      const closeBtn = page.locator('button[aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await closeBtn.click({ timeout: 1000 }).catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await sleep(500);
    }
  } catch {
    // No modal present - nothing to do.
  }
}

// Dismisses the "Game Error" / matchmaking error dialog if present, by
// clicking its light-colored action button - never the X (that just leaves
// the error on screen without resetting matchmaking state). That button's
// label varies ("Main Menu", "Rejoin", etc. depending on the error), so we
// match on the known variants rather than one fixed string.
async function dismissErrorDialogIfPresent(page, botLabel) {
  try {
    // Multiple known error-dialog headlines seen on this platform - add
    // more here if you spot another variant.
    const errorPatterns = [
      'text=Game Error',
      'text=fatal runtime error',
      'text=stopped after a fatal',
    ];
    let errorVisible = false;
    for (const pattern of errorPatterns) {
      if (await page.locator(pattern).first().isVisible({ timeout: 500 }).catch(() => false)) {
        errorVisible = true;
        break;
      }
    }
    if (!errorVisible) return false;

    const actionBtn = page.locator(
      'button:has-text("Resume"), button:has-text("Main Menu"), button:has-text("Rejoin"), button:has-text("Try Again"), button:has-text("Retry")'
    ).first();

    if (await actionBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      const label = await actionBtn.innerText().catch(() => "action button");
      console.log(`[${botLabel}] Detected Game Error dialog - clicking "${label}".`);
      await actionBtn.click({ timeout: 2000 }).catch(() => {});
      await sleep(1500);
      return true;
    }
    console.log(`[${botLabel}] Game Error dialog visible but no known action button matched.`);
  } catch {
    // No error dialog present - nothing to do.
  }
  return false;
}

// Try a handful of likely selectors/text for a "Play" / "Join" button.
// Falls back to doing nothing if none are found — the page may auto-join.
async function tryClickPlay(page, botLabel = "join") {
  // Close any "Play on Phone" (or similar) modal that may already be open -
  // a generic "Play" match can accidentally trigger this instead of the
  // real join button, since "Play on Phone" also contains the word "Play".
  await closePhoneModalIfOpen(page);
  // Also clear a "Game Error" / matchmaking error dialog if one's already
  // showing, so it doesn't block finding the real join button below.
  await dismissErrorDialogIfPresent(page, botLabel);

  const candidates = [
    // Specific phrases first, so we never accidentally match "Play on Phone".
    'button:has-text("Instant Play")',
    'button:has-text("Play Now")',
    'button:has-text("Play in Browser")',
    'button:has-text("Start")',
    'button:has-text("Join")',
    '[data-testid="play-button"]',
    // Broad "Play" match last, and only if nothing more specific matched -
    // still risky (could match "Play on Phone"), so it's a last resort.
    'button:has-text("Play"):not(:has-text("Phone"))',
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

// Checks whether the game seems to have kicked us back to a join/play/
// reconnect prompt, and clicks through it immediately if so. Reuses the
// same candidate selectors as the initial join, since a disconnect often
// just dumps you back on that same screen. Best-effort: if this specific
// game's disconnect screen uses different text/selectors, this may miss
// it - the fix is adding the right selector to this same list.
async function tryReconnectIfNeeded(page, botLabel) {
  await closePhoneModalIfOpen(page);
  const dismissedError = await dismissErrorDialogIfPresent(page, botLabel);

  const candidates = [
    'button:has-text("Reconnect")',
    'button:has-text("Rejoin")',
    'text=Disconnected',
    'text=Connection lost',
    'button:has-text("Instant Play")',
    'button:has-text("Play Now")',
    'button:has-text("Join")',
    'button:has-text("Play"):not(:has-text("Phone"))',
  ];
  for (const selector of candidates) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 500 })) {
        console.log(`[${botLabel}] Detected disconnect/rejoin prompt (${selector}) - rejoining.`);
        await el.click({ timeout: 2000 }).catch(() => {});
        await sleep(3000);
        return true;
      }
    } catch {
      // selector not present - keep checking the others
    }
  }
  return dismissedError;
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

    // Hold a movement key briefly rather than just tapping it - a single
    // press/release often registers as barely a step in most web games,
    // so screenshots end up looking like one static spot. Holding it for
    // several hundred ms actually moves a character/camera enough to
    // explore different parts of the map. Includes both arrow keys and
    // WASD since games vary in which they listen for.
    const keys = [
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "w", "a", "s", "d",
      "Space",
    ];
    const key = keys[Math.floor(Math.random() * keys.length)];
    await page.keyboard.down(key).catch(() => {});
    await sleep(400 + Math.floor(Math.random() * 500)); // hold ~0.4-0.9s
    await page.keyboard.up(key).catch(() => {});
  } catch {
    // Non-fatal — the game canvas may not respond to synthetic input,
    // that's fine, we still get screenshots of whatever state it's in.
  }
}

async function observeGame(page, botDir, botLabel) {
  await ensureDir(botDir);
  const screenshots = [];
  let reconnectCount = 0;
  const totalMs = OBSERVE_MINUTES * 60 * 1000;
  const intervalMs = SCREENSHOT_INTERVAL_SECONDS * 1000;
  const shots = Math.max(1, Math.floor(totalMs / intervalMs));

  for (let i = 0; i < shots; i++) {
    const reconnected = await tryReconnectIfNeeded(page, botLabel);
    if (reconnected) reconnectCount++;
    await nudgeAround(page);
    const filePath = path.join(botDir, `shot-${String(i).padStart(3, "0")}.png`);
    try {
      await page.screenshot({ path: filePath });
      screenshots.push(filePath);
      console.log(`[${botLabel}] Saved screenshot ${i + 1}/${shots}`);
    } catch (err) {
      console.warn(`[${botLabel}] Screenshot ${i + 1} failed: ${err.message}`);
      if (page.isClosed()) {
        console.error(`[${botLabel}] Page is closed - stopping early.`);
        break;
      }
    }
    // Split the wait into smaller chunks with a nudge in between, so
    // activity looks more continuous rather than one blip every interval.
    const half = Math.floor(intervalMs / 2);
    await sleep(half);
    await nudgeAround(page);
    await sleep(intervalMs - half);
  }

  if (reconnectCount > 0) {
    console.log(`[${botLabel}] Rejoined ${reconnectCount} time(s) during observation.`);
  }

  return { screenshots, reconnectCount };
}

// Runs a single bot end-to-end: joins the game, extracts info, observes,
// and closes its browser context. Bots share one underlying browser process
// but each gets its own context (like a separate incognito window) so they
// behave like independent players without the overhead of N full browsers -
// important since GitHub's free runners only have 2 CPU cores / 7GB RAM,
// and launching a whole separate Chromium per bot can starve everyone once
// you're running more than a couple at once.
async function runBot(browser, botIndex) {
  const botLabel = `bot-${botIndex + 1}`;
  const botDir = path.join(outDir, botLabel);

  console.log(`[${botLabel}] Joining: ${GAME_URL}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Surface crashes/disconnects clearly in the logs instead of failing
  // silently - this is exactly what we want visibility into if a bot
  // drops out partway through.
  page.on("crash", () => {
    console.error(`[${botLabel}] Page CRASHED at ${new Date().toISOString()}`);
  });
  page.on("close", () => {
    console.warn(`[${botLabel}] Page closed at ${new Date().toISOString()}`);
  });

  try {
    // Game pages like this often keep a live connection (websocket/polling)
    // running forever, so "networkidle" never fires. Wait for the basic
    // page load instead, then give it extra time for assets to render.
    await page.goto(GAME_URL, { waitUntil: "load", timeout: 45000 });
    await sleep(8000);

    const info = await extractGameInfo(page);
    console.log(`[${botLabel}] Extracted page info:`, info.title);

    await tryClickPlay(page, botLabel);
    await sleep(3000);

    console.log(
      `[${botLabel}] Observing for ~${OBSERVE_MINUTES} minute(s), screenshot every ${SCREENSHOT_INTERVAL_SECONDS}s...`
    );
    const { screenshots: screenshotPaths, reconnectCount } = await observeGame(
      page,
      botDir,
      botLabel
    );

    return { botLabel, info, screenshotPaths, reconnectCount };
  } catch (err) {
    console.error(`[${botLabel}] Bot failed: ${err.message}`);
    return { botLabel, info: { title: "", metaDescription: null, bodyTextSnippet: "" }, screenshotPaths: [], error: err.message };
  } finally {
    await context.close().catch(() => {});
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

  for (const { botLabel, screenshotPaths, reconnectCount } of botResults) {
    const sampled = screenshotPaths.slice(0, MAX_SCREENSHOTS_PER_BOT_FOR_REPORT);
    const reconnectNote = reconnectCount > 0 ? `, rejoined ${reconnectCount}x after being disconnected` : "";
    perBotSections.push(`${botLabel}: ${sampled.length} screenshots attached${reconnectNote}`);
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
   over time when it should, error states, empty/blank screens). Pay close
   attention to any bot noted below as having rejoined after a disconnect -
   that means the session got kicked and had to rejoin mid-observation,
   which is worth flagging explicitly even if the rest of the screenshots
   look fine, since it likely affects real players too (e.g. a guest/
   anonymous session timeout).${multiBot ? `
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

  const browser = await chromium.launch();
  let botResults;
  try {
    botResults = await Promise.all(
      Array.from({ length: BOT_COUNT }, (_, i) => runBot(browser, i))
    );
  } finally {
    await browser.close();
  }

  const failedBots = botResults.filter((r) => r.error);
  if (failedBots.length > 0) {
    console.warn(
      `${failedBots.length}/${BOT_COUNT} bot(s) failed: ${failedBots
        .map((r) => `${r.botLabel} (${r.error})`)
        .join(", ")}`
    );
  }
  // Only bots that actually produced screenshots are useful for the report.
  const usableBots = botResults.filter((r) => r.screenshotPaths.length > 0);
  if (usableBots.length === 0) {
    throw new Error("No bots produced any screenshots - nothing to report.");
  }

  console.log("Generating report...");
  const report = await buildReportWithClaude({ url: GAME_URL, botResults: usableBots });

  const info = usableBots[0].info;
  const failedNote =
    failedBots.length > 0
      ? `\n**Note:** ${failedBots.length}/${BOT_COUNT} bot(s) failed to produce useful data and were excluded from the report below (see logs for details).\n`
      : "";
  const totalReconnects = usableBots.reduce((sum, b) => sum + (b.reconnectCount || 0), 0);
  const reconnectNote =
    totalReconnects > 0
      ? `\n**Note:** Bots were disconnected and had to rejoin ${totalReconnects} time(s) total across the observation window - see the report below for details.\n`
      : "";
  const reportPath = path.join(outDir, "report.md");
  await fs.writeFile(
    reportPath,
    `# Playtest report\n\n**Game:** ${info.title || GAME_URL}\n**URL:** ${GAME_URL}\n**Run:** ${runId}\n**Bots:** ${BOT_COUNT}\n${failedNote}${reconnectNote}\n---\n\n${report}\n`
  );

  console.log(`\nDone. Report saved to: ${reportPath}`);
}

main().catch((err) => {
  console.error("Bot run failed:", err);
  process.exit(1);
});
