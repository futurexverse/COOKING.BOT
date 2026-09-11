import { config } from "dotenv";
import { analyzeMarket, updateMindSnapshot } from "../market/analyzer.js";
import { evaluateLaunchConditions } from "../launch/criteria.js";
import { executeLaunch, getActiveLaunches } from "../launch/launcher.js";
import { processApproval } from "../social/approval.js";
import { startTelegramBot, sendGuardianAlertToTelegram } from "../social/telegram-bot.js";
import { refreshNarratives } from "../market/narrative.js";
import {
  runGuardianCycle,
  getAllActiveGuardians,
} from "../guardian/monitor.js";
import {
  isAnchorCoolingDown,
  isDiverseAnchor,
  markAnchorPosted,
} from "../dedup/deduplication.js";
import type { ScanRequest, ScoredSignal } from "../schemas/index.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

config();

const DATA_DIR = process.env.ORACLE_DATA_DIR || "data";
const STATE_FILE = join(DATA_DIR, "bot_state.json");
const SCAN_INTERVAL =
  parseInt(process.env.ORACLE_SCAN_INTERVAL_SECONDS || "300", 10) * 1000;
const GUARDIAN_INTERVAL =
  parseInt(process.env.GUARDIAN_INTERVAL_SECONDS || "60", 10) * 1000;

interface BotState {
  last_scan_time: number;
  cycle_count: number;
  total_signals: number;
  total_launches: number;
}

let state: BotState = {
  last_scan_time: 0,
  cycle_count: 0,
  total_signals: 0,
  total_launches: 0,
};

function loadState(): void {
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      /* ignore */
    }
  }
}

function saveState(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function runScanCycle(): Promise<{ signal?: ScoredSignal; heat?: number; candidates: number }> {
  console.log(`\n[Bot] === Scan Cycle #${state.cycle_count + 1} ===`);

  const request: ScanRequest = {
    solana_trending: [],
    oracle_memory_last3: [],
    mode: "aggressive",
    intensitySpike: false,
  };

  const result = await analyzeMarket(request);
  state.cycle_count++;
  state.total_signals += result.candidates_scored;
  state.last_scan_time = Date.now();

  console.log(
    `[Bot] ${result.candidates_scored} candidates scored | should_post=${result.should_post}`
  );

  if (result.should_post && result.signal) {
    const sig = result.signal;
    console.log(
      `[Bot] Best: $${sig.symbol} | score=${sig.score.toFixed(3)} | 24h=${sig.change_24h.toFixed(1)}% | vol=$${sig.volume_24h}`
    );

    const cooledDown = !isAnchorCoolingDown(sig.symbol);
    const diverse = isDiverseAnchor(sig.symbol);

    if (cooledDown && diverse) {
      markAnchorPosted(sig.symbol);
      console.log(`[Bot] Signal recorded: $${sig.symbol} (score: ${sig.score.toFixed(3)})`);
    } else {
      const reasons = [];
      if (!cooledDown) reasons.push("anchor_cooling");
      if (!diverse) reasons.push("diversity");
      console.log(`[Bot] Signal skipped: ${reasons.join(", ")}`);
    }

    const heat = calculateMarketHeat(result.candidates_scored, sig.score);
    updateMindSnapshot(
      `Market heat: ${(heat * 100).toFixed(0)}% | Best signal: $${sig.symbol} (${(sig.score * 100).toFixed(0)}%) | Candidates: ${result.candidates_scored}`
    );

    saveState();
    return { signal: sig, heat, candidates: result.candidates_scored };
  }

  saveState();
  return { candidates: result.candidates_scored };
}

async function runLaunchCycle(signal?: ScoredSignal, marketHeat?: number): Promise<void> {
  let trendingNarratives: string[] = [];
  try {
    const narrativeAnalysis = await refreshNarratives();
    trendingNarratives = narrativeAnalysis.trending_narratives;
  } catch {
    trendingNarratives = [];
  }

  const proposal = await evaluateLaunchConditions({
    signal,
    market_heat: marketHeat || 0.5,
    trending_narratives: trendingNarratives,
  });

  console.log(
    `[Bot] Launch proposal: $${proposal.symbol} | confidence=${(proposal.confidence * 100).toFixed(0)}% | status=${proposal.status}`
  );

  if (proposal.status === "pending") {
    console.log(
      `[Bot] Waiting for approval (ID: ${proposal.decision_id})...`
    );
    const method = process.env.APPROVAL_METHOD || "api";

    if (method === "auto") {
      const autoResult = await processApproval({
        decision_id: proposal.decision_id,
        approved: true,
      });
      if (autoResult.success) {
        await executeLaunch(proposal);
      }
    } else {
      console.log(
        `[Bot] Awaiting manual approval via ${method}. Use POST /api/approve/${proposal.decision_id}`
      );
    }
  }
}

async function runGuardianCycles(): Promise<void> {
  const launches = getActiveLaunches();
  const activeLaunches = launches.filter((l) => l.guardian_active);

  if (activeLaunches.length === 0) return;

  console.log(`[Bot] Guardian: checking ${activeLaunches.length} active token(s)`);

  for (const launch of activeLaunches) {
    try {
      const result = await runGuardianCycle(launch);

      for (const alert of result.alerts) {
        console.log(`[Bot] $${launch.symbol}: ${alert.type} — ${alert.message}`);
        sendGuardianAlertToTelegram({
          type: alert.type,
          symbol: launch.symbol,
          message: alert.message,
          severity: alert.severity,
          tokenAddress: launch.mint,
        }).catch(() => {});
      }

      for (const alert of result.performanceAlerts) {
        console.log(`[Bot] $${launch.symbol}: ${alert.type} — ${alert.message}`);
        sendGuardianAlertToTelegram({
          type: alert.type,
          symbol: launch.symbol,
          message: alert.message,
          severity: alert.severity,
          tokenAddress: launch.mint,
        }).catch(() => {});
      }

      if (result.lpAction.should_exit) {
        console.log(`[Bot] $${launch.symbol}: LP EXIT - ${result.lpAction.reason}`);
        sendGuardianAlertToTelegram({
          type: result.lpAction.exit_type || "exit",
          symbol: launch.symbol,
          message: `${result.lpAction.reason}${result.lpAction.pnl_pct ? ` (PnL: ${result.lpAction.pnl_pct > 0 ? "+" : ""}${result.lpAction.pnl_pct.toFixed(1)}%)` : ""}`,
          severity: result.lpAction.exit_type === "emergency" ? "critical" : "warning",
          tokenAddress: launch.mint,
          pnlPct: result.lpAction.pnl_pct,
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[Bot] Guardian error for $${launch.symbol}:`, err);
    }
  }
}

function calculateMarketHeat(candidates: number, bestScore: number): number {
  const candidateHeat = Math.min(candidates / 20, 1) * 0.4;
  const scoreHeat = bestScore * 0.6;
  return Math.min(1, candidateHeat + scoreHeat);
}

async function runFullCycle(): Promise<void> {
  console.log(`\n[Bot] Starting full cycle at ${new Date().toISOString()}`);

  let scanResult: { signal?: ScoredSignal; heat?: number; candidates: number } = { candidates: 0 };

  try {
    scanResult = await runScanCycle();
  } catch (err) {
    console.error("[Bot] Scan cycle error:", err);
  }

  try {
    await runGuardianCycles();
  } catch (err) {
    console.error("[Bot] Guardian cycle error:", err);
  }

  if (process.env.LAUNCH_ENABLED === "true") {
    try {
      await runLaunchCycle(scanResult.signal, scanResult.heat);
    } catch (err) {
      console.error("[Bot] Launch cycle error:", err);
    }
  }
}

async function main(): Promise<void> {
  console.log("========================================");
  console.log("      COOKING - BOT MODE");
  console.log("========================================");
  console.log(`[Bot] Scan interval: ${SCAN_INTERVAL / 1000}s`);
  console.log(`[Bot] Guardian interval: ${GUARDIAN_INTERVAL / 1000}s`);
  console.log(
    `[Bot] Launch enabled: ${process.env.LAUNCH_ENABLED === "true"}`
  );

  loadState();
  startTelegramBot();

  let lastGuardianRun = 0;

  while (true) {
    await runFullCycle();

    if (Date.now() - lastGuardianRun >= GUARDIAN_INTERVAL) {
      try {
        await runGuardianCycles();
        lastGuardianRun = Date.now();
      } catch (err) {
        console.error("[Bot] Standalone guardian error:", err);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, SCAN_INTERVAL));
  }
}

main().catch((err) => {
  console.error("[Bot] Fatal error:", err);
  process.exit(1);
});
