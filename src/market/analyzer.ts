import type {
  ScanRequest,
  ScanResponse,
  TokenCandidate,
  ScoredSignal,
  EnrichedDecision,
} from "../schemas/index.js";
import { fetchJupiterTrending } from "./sources/jupiter.js";
import { fetchDexscreenerTrending } from "./sources/dexscreener.js";
import { fetchTokenSafety } from "./sources/helius.js";
import { fetchPumpFunTrending } from "./sources/pumpfun.js";
import { fetchLunarCrushTrending } from "./sources/lunacrush.js";
import { fetchUniswapTopPools } from "./sources/uniswap.js";
import { fetchBlockscoutTrendingTokens } from "./sources/blockscout.js";
import { refreshNarratives, getNarrativeScore, type NarrativeAnalysis } from "./narrative.js";
import {
  rankTokens,
  filterBlacklisted,
  passesBasicGates,
} from "./scoring.js";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

let lastNarrativeSentAt = 0;

const DATA_DIR = process.env.ORACLE_DATA_DIR || "data";
const DECISIONS_FILE = join(DATA_DIR, "decisions.json");

const decisions: EnrichedDecision[] = [];
let lastScoredTokens: ScoredSignal[] = [];
let lastMarketHeat = 0;

const dashboardData = {
  mind_snapshot: { content: "Scanning Solana markets..." },
  oracle_state: { novelty_summary: "Cold boot — no persona history yet." },
};

function loadDecisions(): void {
  if (existsSync(DECISIONS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(DECISIONS_FILE, "utf-8"));
      decisions.push(...data);
    } catch {
      /* ignore corrupt file */
    }
  }
}

function saveDecisions(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  const toSave = decisions.slice(-500);
  writeFileSync(DECISIONS_FILE, JSON.stringify(toSave, null, 2));
}

loadDecisions();

export async function analyzeMarket(
  request: ScanRequest
): Promise<ScanResponse> {
  let candidates = request.solana_trending;

  if (!candidates || candidates.length === 0) {
    candidates = await fetchTrendingFromSource();
  }

  const filtered = filterBlacklisted(candidates);
  const gated = filtered.filter(passesBasicGates);

  const scored = rankTokens(gated);

  let narrativeAnalysis: NarrativeAnalysis | null = null;
  try {
    narrativeAnalysis = await refreshNarratives();

    const now = Date.now();
    if (narrativeAnalysis && now - lastNarrativeSentAt > 600000) {
      lastNarrativeSentAt = now;
      const { sendNarrativeToTelegram } = await import("../social/telegram-bot.js");
      sendNarrativeToTelegram({
        trending_narratives: narrativeAnalysis.trending_narratives,
        theme_scores: narrativeAnalysis.theme_scores,
        tokens_per_narrative: narrativeAnalysis.tokens_per_narrative,
        reasoning: narrativeAnalysis.reasoning,
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[Analyzer] Narrative refresh failed:", (err as Error).message);
  }

  for (const sig of scored) {
    if (narrativeAnalysis) {
      const { score: narrativeScore, matched_narratives } = getNarrativeScore(
        sig.name || "",
        sig.symbol,
        narrativeAnalysis
      );
      sig.narrative_score = narrativeScore;
      sig.matched_narratives = matched_narratives;

      const narrativeBoost = Math.round(narrativeScore * 0.15);
      sig.score = Math.min(1, sig.score + narrativeBoost / 100);

      if (matched_narratives.length > 0) {
        sig.breakdown["narrative_boost"] = narrativeBoost;
      }
    }

    if (sig.mint && process.env.HELIUS_API_KEY) {
      const safety = await fetchTokenSafety(sig.mint);
      if (safety) {
        sig.safety = {
          has_freeze_authority: safety.has_freeze_authority,
          has_mint_authority: safety.has_mint_authority,
        };
        if (
          safety.has_freeze_authority &&
          process.env.ORACLE_TOP5_REJECT_FREEZE_AUTHORITY !== "false"
        ) {
          sig.score *= 0.5;
        }
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  lastScoredTokens = scored;

  const actionable = scored.filter((s) => s.signal_type === "actionable");
  const best = actionable[0];

  const heat = calculateMarketHeat(scored.length, best?.score || 0);
  lastMarketHeat = heat;

  const decisionId = randomUUID();
  const decision: EnrichedDecision = {
    decision_id: decisionId,
    anchor: best?.symbol || "NONE",
    score: best?.score || 0,
    type: best?.signal_type || "fallback",
    call_type: best ? "live_call" : undefined,
    strategy_id: "cooking_v1",
    created_at: Date.now(),
    candidates_scored: scored.length,
    market_heat: heat,
    signal_data: best || undefined,
  };
  decisions.push(decision);
  if (decisions.length > 500) decisions.shift();
  saveDecisions();

  const shouldPost = !!best;

  const signal_type = best?.signal_type === "actionable" ? "actionable" : best?.signal_type === "watchlist" ? "watchlist" : "fallback";

  updateMindSnapshot(
    `Market heat: ${(heat * 100).toFixed(0)}% | Best: $${best?.symbol || "NONE"} (${((best?.score || 0) * 100).toFixed(0)}%) | ${scored.length} candidates`
  );

  return {
    should_post: shouldPost,
    signal: best || undefined,
    signal_type,
    decision_id: decisionId,
    anchor: best?.symbol,
    call_type: best ? "live_call" : undefined,
    candidates_scored: scored.length,
  };
}

function calculateMarketHeat(candidates: number, bestScore: number): number {
  const candidateHeat = Math.min(candidates / 20, 1) * 0.4;
  const scoreHeat = bestScore * 0.6;
  return Math.min(1, candidateHeat + scoreHeat);
}

async function fetchTrendingFromSource(): Promise<TokenCandidate[]> {
  const source = process.env.ORACLE_TRENDING_SOURCE || "uniswap";
  const limit = parseInt(
    process.env.ORACLE_JUPITER_TRENDING_LIMIT || "50",
    10
  );

  const allCandidates: TokenCandidate[] = [];

  const primaryPromise = (async () => {
    try {
      switch (source) {
        case "uniswap":
          return await fetchUniswapTopPools(limit);
        case "blockscout":
          return await fetchBlockscoutTrendingTokens(limit);
        case "dexscreener":
          return await fetchDexscreenerTrending(
            process.env.DEXSCREENER_QUERY || "solana"
          );
        case "jupiter":
          return await fetchJupiterTrending(limit);
        default:
          return await fetchUniswapTopPools(limit);
      }
    } catch (err) {
      console.log(`[Analyzer] ${source} failed:`, (err as Error).message);
      try {
        return await fetchUniswapTopPools(limit);
      } catch {
        return [];
      }
    }
  })();

  const blockscoutPromise = fetchBlockscoutTrendingTokens(10).catch((err) => {
    console.error("[Analyzer] Blockscout fetch failed:", (err as Error).message);
    return [];
  });

  const [primary, bsTokens] = await Promise.allSettled([
    primaryPromise,
    blockscoutPromise,
  ]);

  if (primary.status === "fulfilled") allCandidates.push(...primary.value);
  if (bsTokens.status === "fulfilled") allCandidates.push(...bsTokens.value);

  const seen = new Set<string>();
  return allCandidates.filter((t) => {
    const key = t.mint || t.symbol;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getScoredTokens(): ScoredSignal[] {
  return lastScoredTokens;
}

export function getMarketHeat(): number {
  return lastMarketHeat;
}

export async function getDashboardData() {
  let launches: unknown[] = [];
  let guardians: unknown[] = [];

  try {
    const mod = await import("../launch/launcher.js");
    launches = mod.getActiveLaunches();
  } catch {
    /* launcher not initialized */
  }

  try {
    const mod = await import("../guardian/monitor.js");
    guardians = mod.getAllActiveGuardians();
  } catch {
    /* guardian not initialized */
  }

  let pendingProposals: unknown[] = [];
  try {
    const mod = await import("../social/approval.js");
    pendingProposals = mod.getPendingProposals();
  } catch {
    /* approval module not initialized */
  }

  let config: unknown = {};
  try {
    const configRaw = readFileSync(
      join(process.cwd(), "src/config/thresholds.json"),
      "utf-8"
    );
    const cfg = JSON.parse(configRaw);
    config = {
      actionable_gate: cfg.scoring?.thresholds?.actionable_gate ?? 0.70,
      watchlist_gate: cfg.scoring?.thresholds?.watchlist_gate ?? 0.45,
      launch_confidence: cfg.launch?.min_confidence ?? 0.75,
      strategy: "cooking_v1",
      scan_interval: "5 min",
    };
  } catch {
    config = {
      actionable_gate: 0.70,
      watchlist_gate: 0.45,
      launch_confidence: 0.75,
      strategy: "cooking_v1",
      scan_interval: "5 min",
    };
  }

  return {
    decisions: decisions.slice(-50),
    scored_tokens: lastScoredTokens,
    pending_proposals: pendingProposals,
    launches,
    guardians,
    market_heat: lastMarketHeat,
    config,
    mind_snapshot: dashboardData.mind_snapshot,
    oracle_state: dashboardData.oracle_state,
  };
}

export function updateMindSnapshot(content: string) {
  dashboardData.mind_snapshot.content = content;
}

export function updateOracleState(summary: string) {
  dashboardData.oracle_state.novelty_summary = summary;
}
