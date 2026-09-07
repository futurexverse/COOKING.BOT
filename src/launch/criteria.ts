import type { ScoredSignal, LaunchProposal } from "../schemas/index.js";
import { randomUUID } from "crypto";
import { registerProposal } from "../social/approval.js";
import { sendProposalToTelegram } from "../social/telegram-bot.js";

interface LaunchContext {
  signal?: ScoredSignal;
  market_heat?: number;
  trending_narratives?: string[];
  recent_launches?: number;
}

function calculateConfidence(
  signal: ScoredSignal | undefined,
  marketHeat: number,
  recentLaunches: number
): {
  confidence: number;
  platform: "pumpfun" | "raydium" | "noxafun" | "uniswap";
  reasoning: string;
  estimated_cost_sol: number;
  should_launch: boolean;
} {
  if (!signal) {
    return {
      confidence: 0,
      platform: "pumpfun",
      reasoning: "No signal data provided",
      estimated_cost_sol: 0.01,
      should_launch: false,
    };
  }

  let confidence = 0;
  const reasons: string[] = [];

  if (signal.score >= 0.85) {
    confidence += 0.35;
    reasons.push(`High score (${(signal.score * 100).toFixed(0)}%)`);
  } else if (signal.score >= 0.70) {
    confidence += 0.25;
    reasons.push(`Good score (${(signal.score * 100).toFixed(0)}%)`);
  } else {
    confidence += signal.score * 0.3;
    reasons.push(`Low score (${(signal.score * 100).toFixed(0)}%)`);
  }

  if (signal.change_24h > 30) {
    confidence += 0.2;
    reasons.push(`Strong momentum (+${signal.change_24h.toFixed(0)}% 24h)`);
  } else if (signal.change_24h > 10) {
    confidence += 0.1;
    reasons.push(`Moderate momentum (+${signal.change_24h.toFixed(0)}% 24h)`);
  }

  if (signal.volume_24h > 500000) {
    confidence += 0.15;
    reasons.push(`High volume ($${(signal.volume_24h / 1000).toFixed(0)}K)`);
  } else if (signal.volume_24h > 100000) {
    confidence += 0.08;
    reasons.push(`Moderate volume ($${(signal.volume_24h / 1000).toFixed(0)}K)`);
  }

  if (signal.liquidity > 100000) {
    confidence += 0.15;
    reasons.push(`Deep liquidity ($${(signal.liquidity / 1000).toFixed(0)}K)`);
  } else if (signal.liquidity > 30000) {
    confidence += 0.08;
    reasons.push(`Adequate liquidity ($${(signal.liquidity / 1000).toFixed(0)}K)`);
  }

  if (signal.holders && signal.holders > 500) {
    confidence += 0.1;
    reasons.push(`${signal.holders} holders`);
  }

  if (marketHeat > 0.7) {
    confidence += 0.1;
    reasons.push(`Hot market (${(marketHeat * 100).toFixed(0)}%)`);
  }

  if (signal.matched_narratives && signal.matched_narratives.length > 0) {
    const narrativeBoost = signal.narrative_score ? Math.min(0.15, signal.narrative_score / 100 * 0.15) : 0.05;
    confidence += narrativeBoost;
    reasons.push(`Narrative match (${signal.matched_narratives.join(", ")})`);
  }

  if (recentLaunches >= 3) {
    confidence -= 0.15;
    reasons.push(`Market saturated (${recentLaunches} recent launches)`);
  }

  confidence = Math.max(0, Math.min(1, confidence));

  const platform = "noxafun";
  const estimatedCost = 0.01;

  const sourceChain = signal.chain || "unknown";
  const chainName: Record<string, string> = {
    solana: "Solana", ethereum: "Ethereum", base: "Base", bsc: "BSC",
    arbitrum: "Arbitrum", polygon: "Polygon", avalanche: "Avalanche",
    optimism: "Optimism", tron: "Tron", sui: "Sui", aptos: "Aptos",
  };
  reasons.unshift(`Trending on ${chainName[sourceChain] || sourceChain}`);

  const minConfidence = parseFloat(
    process.env.LAUNCH_MIN_CONFIDENCE || "0.75"
  );

  return {
    confidence,
    platform,
    reasoning: reasons.join("; "),
    estimated_cost_sol: estimatedCost,
    should_launch: confidence >= minConfidence,
  };
}

export async function evaluateLaunchConditions(
  context: LaunchContext
): Promise<LaunchProposal> {
  const signal = context.signal;
  const marketHeat = context.market_heat || 0.5;
  const recentLaunches = context.recent_launches || 0;

  const analysis = calculateConfidence(signal, marketHeat, recentLaunches);

  const proposal: LaunchProposal = {
    decision_id: randomUUID(),
    symbol: signal?.symbol || "UNKNOWN",
    name: signal?.name || "Unknown Token",
    platform: analysis.platform,
    confidence: analysis.confidence,
    reasoning: analysis.reasoning,
    estimated_cost_sol: analysis.estimated_cost_sol,
    signal: signal || {
      symbol: "UNKNOWN",
      score: 0,
      signal_type: "noise",
      breakdown: {},
      change_24h: 0,
      volume_24h: 0,
      liquidity: 0,
    },
    created_at: Date.now(),
    status: analysis.should_launch ? "pending" : "rejected",
  };

  if (analysis.should_launch) {
    registerProposal(proposal.decision_id, proposal);
    sendProposalToTelegram({
      decision_id: proposal.decision_id,
      symbol: proposal.symbol,
      confidence: proposal.confidence,
      platform: proposal.platform,
      estimated_cost_sol: proposal.estimated_cost_sol,
      reasoning: proposal.reasoning,
    }).catch(() => {});
  }

  return proposal;
}
