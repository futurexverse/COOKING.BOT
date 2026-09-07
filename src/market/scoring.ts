import type { TokenCandidate, ScoredSignal } from "../schemas/index.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ThresholdConfig {
  scoring: {
    weights: Record<string, number>;
    thresholds: {
      actionable_gate: number;
      watchlist_gate: number;
      min_liquidity_usd: number;
      min_volume_24h_usd: number;
      min_holders: number;
      max_freeze_authority: boolean;
      max_mint_authority: boolean;
    };
    scoring_ranges: Record<string, Record<string, number>>;
  };
}

let cachedConfig: ThresholdConfig | null = null;

function loadThresholds(): ThresholdConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = join(
    __dirname,
    "../../src/config/thresholds.json"
  );
  try {
    cachedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    cachedConfig = getDefaultThresholds();
  }
  return cachedConfig!;
}

function getDefaultThresholds(): ThresholdConfig {
  return {
    scoring: {
      weights: {
        volume_spike: 0.25,
        liquidity_depth: 0.20,
        price_momentum_24h: 0.20,
        price_momentum_1h: 0.15,
        holder_growth: 0.10,
        safety_score: 0.10,
      },
      thresholds: {
        actionable_gate: 0.70,
        watchlist_gate: 0.45,
        min_liquidity_usd: 10000,
        min_volume_24h_usd: 50000,
        min_holders: 50,
        max_freeze_authority: true,
        max_mint_authority: false,
      },
      scoring_ranges: {
        volume_spike: { excellent: 3.0, good: 2.0, moderate: 1.5, poor: 1.0 },
        liquidity_depth: {
          excellent: 500000,
          good: 100000,
          moderate: 50000,
          poor: 10000,
        },
      },
    },
  };
}

function scoreRange(
  value: number,
  ranges: Record<string, number>
): number {
  if (value >= ranges.excellent) return 1.0;
  if (value >= ranges.good) return 0.75;
  if (value >= ranges.moderate) return 0.5;
  if (value >= ranges.poor) return 0.25;
  return 0.0;
}

function scoreVolumeSpike(token: TokenCandidate): number {
  const ratio =
    token.volume_24h > 0 && token.liquidity > 0
      ? token.volume_24h / token.liquidity
      : 0;
  const config = loadThresholds();
  return scoreRange(ratio, config.scoring.scoring_ranges.volume_spike);
}

function scoreLiquidityDepth(token: TokenCandidate): number {
  const config = loadThresholds();
  return scoreRange(
    token.liquidity,
    config.scoring.scoring_ranges.liquidity_depth
  );
}

function scoreMomentum(change: number): number {
  const abs = Math.abs(change);
  if (abs >= 50) return 1.0;
  if (abs >= 30) return 0.85;
  if (abs >= 20) return 0.7;
  if (abs >= 10) return 0.5;
  if (abs >= 5) return 0.3;
  return 0.1;
}

function scoreHolders(token: TokenCandidate): number {
  const holders = token.holders || 0;
  if (holders >= 1000) return 1.0;
  if (holders >= 500) return 0.8;
  if (holders >= 200) return 0.6;
  if (holders >= 100) return 0.4;
  if (holders >= 50) return 0.2;
  return 0.0;
}

function scoreSafety(token: TokenCandidate): number {
  let score = 1.0;

  if (token.liquidity < 5000) score -= 0.3;
  if (token.volume_24h < 10000) score -= 0.2;

  return Math.max(0, score);
}

export function scoreToken(token: TokenCandidate): ScoredSignal {
  const config = loadThresholds();
  const weights = config.scoring.weights;

  const breakdown: Record<string, number> = {};
  breakdown.volume_spike = scoreVolumeSpike(token);
  breakdown.liquidity_depth = scoreLiquidityDepth(token);
  breakdown.price_momentum_24h = scoreMomentum(token.change_24h);
  breakdown.price_momentum_1h = scoreMomentum(token.change_1h || 0);
  breakdown.holder_growth = scoreHolders(token);
  breakdown.safety_score = scoreSafety(token);

  const totalScore = Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + (breakdown[key] || 0) * weight,
    0
  );

  const clampedScore = Math.min(1, Math.max(0, totalScore));

  const { actionable_gate, watchlist_gate } = config.scoring.thresholds;
  let signal_type: "actionable" | "watchlist" | "noise";
  if (clampedScore >= actionable_gate) {
    signal_type = "actionable";
  } else if (clampedScore >= watchlist_gate) {
    signal_type = "watchlist";
  } else {
    signal_type = "noise";
  }

  return {
    symbol: token.symbol,
    name: token.name,
    mint: token.mint,
    chain: token.chain,
    score: clampedScore,
    signal_type,
    breakdown,
    change_24h: token.change_24h,
    change_1h: token.change_1h,
    volume_24h: token.volume_24h,
    liquidity: token.liquidity,
    holders: token.holders,
    market_cap: token.market_cap,
    price: token.price,
    source: token.source,
  };
}

export function rankTokens(
  tokens: TokenCandidate[]
): ScoredSignal[] {
  const scored = tokens.map(scoreToken);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function filterBlacklisted(tokens: TokenCandidate[]): TokenCandidate[] {
  const blacklist = (
    process.env.ORACLE_BLACKLIST_SYMBOLS || "SNS,UNTAXED"
  )
    .split(",")
    .map((s) => s.trim().toUpperCase());

  return tokens.filter(
    (t) => !blacklist.includes(t.symbol.toUpperCase())
  );
}

export function passesBasicGates(token: TokenCandidate): boolean {
  const config = loadThresholds();
  const { min_liquidity_usd, min_volume_24h_usd } =
    config.scoring.thresholds;

  if (token.liquidity < min_liquidity_usd) return false;
  if (token.volume_24h < min_volume_24h_usd) return false;
  return true;
}
