import { fetchPumpFunTrending } from "./sources/pumpfun.js";
import { fetchLunarCrushTrending } from "./sources/lunacrush.js";
import { analyzeNarrative, type NarrativeAnalysis } from "./sources/openai.js";

let cachedNarratives: NarrativeAnalysis | null = null;
let lastNarrativeFetch = 0;
const NARRATIVE_CACHE_TTL = 300000;

export type { NarrativeAnalysis };

export async function refreshNarratives(): Promise<NarrativeAnalysis> {
  const now = Date.now();
  if (cachedNarratives && now - lastNarrativeFetch < NARRATIVE_CACHE_TTL) {
    return cachedNarratives;
  }

  console.log("[Narrative] Fetching data from Pump.fun + LunarCrush...");

  const [pumpfunData, lunacrushData] = await Promise.allSettled([
    fetchPumpFunTrending(),
    fetchLunarCrushTrending(),
  ]);

  const pf = pumpfunData.status === "fulfilled" ? pumpfunData.value : [];
  const lc = lunacrushData.status === "fulfilled" ? lunacrushData.value : [];

  console.log(`[Narrative] Pump.fun: ${pf.length} tokens, LunarCrush: ${lc.length} tokens`);

  const pfSummary = pf.slice(0, 10).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    market_cap: t.market_cap || 0,
    holder_count: t.holders || 0,
    description: "",
  }));

  const lcSummary = lc.slice(0, 10).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    social_sentiment: 50,
    social_mentions: t.holders || 0,
    volume_24h: t.volume_24h || 0,
  }));

  const analysis = await analyzeNarrative(pfSummary, lcSummary);

  cachedNarratives = analysis;
  lastNarrativeFetch = now;

  console.log(`[Narrative] Found: ${analysis.trending_narratives.join(", ")}`);
  return analysis;
}

export function getNarrativeScore(
  tokenDescription: string,
  tokenSymbol: string,
  narrativeAnalysis: NarrativeAnalysis
): { score: number; matched_narratives: string[] } {
  const text = `${tokenDescription} ${tokenSymbol}`.toLowerCase();
  const matched: string[] = [];
  let totalScore = 0;

  for (const narrative of narrativeAnalysis.trending_narratives) {
    const narrativeLower = narrative.toLowerCase();
    const keywords = narrativeLower.split(/\s+/);

    const matchedKeywords = keywords.filter((kw) => text.includes(kw));
    if (matchedKeywords.length > 0) {
      const matchRatio = matchedKeywords.length / keywords.length;
      const themeScore = narrativeAnalysis.theme_scores[narrative] || 50;
      const score = matchRatio * themeScore;
      totalScore += score;
      matched.push(narrative);
    }
  }

  const normalized = narrativeAnalysis.trending_narratives.length > 0
    ? Math.min(100, totalScore / narrativeAnalysis.trending_narratives.length)
    : 50;

  return { score: normalized, matched_narratives: matched };
}

export function getNarrativeBoost(
  tokenSymbol: string,
  tokenDescription: string,
  narrativeAnalysis: NarrativeAnalysis
): number {
  const { score } = getNarrativeScore(tokenDescription, tokenSymbol, narrativeAnalysis);
  return Math.round(score * 0.15);
}

export function isNarrativeStale(): boolean {
  return Date.now() - lastNarrativeFetch > NARRATIVE_CACHE_TTL;
}
