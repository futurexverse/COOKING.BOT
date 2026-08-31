import { z } from "zod";

export const TokenCandidateSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  mint: z.string().optional(),
  change_24h: z.number(),
  change_1h: z.number().optional(),
  volume_24h: z.number(),
  volume_1h: z.number().optional(),
  liquidity: z.number(),
  holders: z.number().optional(),
  market_cap: z.number().optional(),
  price: z.number().optional(),
  source: z.enum(["jupiter", "dexscreener", "pumpfun", "lunacrush"]).optional(),
  narrative_match: z.array(z.string()).optional(),
  narrative_score: z.number().optional(),
});

export type TokenCandidate = z.infer<typeof TokenCandidateSchema>;

export const ScanRequestSchema = z.object({
  solana_trending: z.array(TokenCandidateSchema),
  oracle_memory_last3: z.array(z.string()).default([]),
  mode: z.enum(["aggressive", "neutral", "conservative"]).default("neutral"),
  endingStyle: z.string().optional(),
  intensitySpike: z.boolean().default(false),
  token_mentions: z.record(z.string(), z.number()).optional(),
});

export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export const ScoredSignalSchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  mint: z.string().optional(),
  score: z.number().min(0).max(1),
  signal_type: z.enum(["actionable", "watchlist", "noise"]),
  breakdown: z.record(z.number()),
  narrative_score: z.number().optional(),
  matched_narratives: z.array(z.string()).optional(),
  change_24h: z.number(),
  change_1h: z.number().optional(),
  volume_24h: z.number(),
  liquidity: z.number(),
  holders: z.number().optional(),
  market_cap: z.number().optional(),
  price: z.number().optional(),
  source: z.string().optional(),
  safety: z
    .object({
      has_freeze_authority: z.boolean().optional(),
      has_mint_authority: z.boolean().optional(),
      is_honeypot: z.boolean().optional(),
    })
    .optional(),
});

export type ScoredSignal = z.infer<typeof ScoredSignalSchema>;

export const ScanResponseSchema = z.object({
  should_post: z.boolean(),
  signal: ScoredSignalSchema.optional(),
  signal_type: z.enum(["actionable", "watchlist", "fallback"]).optional(),
  decision_id: z.string().optional(),
  anchor: z.string().optional(),
  call_type: z.string().optional(),
  candidates_scored: z.number(),
});

export type ScanResponse = z.infer<typeof ScanResponseSchema>;

export const LaunchProposalSchema = z.object({
  decision_id: z.string(),
  symbol: z.string(),
  name: z.string(),
  platform: z.enum(["pumpfun", "raydium"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  estimated_cost_sol: z.number(),
  signal: ScoredSignalSchema,
  created_at: z.number(),
  status: z.enum(["pending", "approved", "rejected", "executed", "failed"]),
});

export type LaunchProposal = z.infer<typeof LaunchProposalSchema>;

export const LaunchRecordSchema = z.object({
  decision_id: z.string(),
  symbol: z.string(),
  name: z.string(),
  mint: z.string(),
  platform: z.enum(["pumpfun", "raydium"]),
  tx_signature: z.string(),
  cost_sol: z.number(),
  launched_at: z.number(),
  guardian_active: z.boolean(),
  initial_price: z.number().optional(),
  initial_liquidity: z.number().optional(),
});

export type LaunchRecord = z.infer<typeof LaunchRecordSchema>;

export const GuardianStatusSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  active: z.boolean(),
  uptime_seconds: z.number(),
  current_price: z.number().optional(),
  price_change_pct: z.number().optional(),
  volume_24h: z.number().optional(),
  holders: z.number().optional(),
  liquidity: z.number().optional(),
  pnl_pct: z.number().optional(),
  alerts: z.array(
    z.object({
      type: z.string(),
      message: z.string(),
      timestamp: z.number(),
      severity: z.enum(["info", "warning", "critical"]),
    })
  ),
  last_check: z.number(),
});

export type GuardianStatus = z.infer<typeof GuardianStatusSchema>;

export const ApprovalRequestSchema = z.object({
  decision_id: z.string(),
  approved: z.boolean(),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const EnrichedDecisionSchema = z.object({
  decision_id: z.string(),
  anchor: z.string(),
  score: z.number(),
  type: z.string(),
  call_type: z.string().optional(),
  strategy_id: z.string().optional(),
  created_at: z.number(),
  candidates_scored: z.number().optional(),
  market_heat: z.number().optional(),
  signal_data: ScoredSignalSchema.optional(),
});

export type EnrichedDecision = z.infer<typeof EnrichedDecisionSchema>;

export const DashboardResponseSchema = z.object({
  decisions: z.array(EnrichedDecisionSchema),
  scored_tokens: z.array(ScoredSignalSchema),
  pending_proposals: z.array(LaunchProposalSchema),
  launches: z.array(LaunchRecordSchema),
  guardians: z.array(GuardianStatusSchema),
  market_heat: z.number(),
  config: z
    .object({
      actionable_gate: z.number(),
      watchlist_gate: z.number(),
      launch_confidence: z.number(),
      strategy: z.string(),
      scan_interval: z.string(),
    })
    .optional(),
  mind_snapshot: z
    .object({
      content: z.string(),
    })
    .optional(),
  oracle_state: z
    .object({
      novelty_summary: z.string().optional(),
    })
    .optional(),
});
