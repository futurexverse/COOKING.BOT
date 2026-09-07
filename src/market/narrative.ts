import { fetchPumpFunTrending } from "./sources/pumpfun.js";
import { fetchLunarCrushTrending } from "./sources/lunacrush.js";
import { analyzeNarrative, type NarrativeAnalysis } from "./sources/openai.js";

let cachedNarratives: NarrativeAnalysis | null = null;
let lastNarrativeFetch = 0;
const NARRATIVE_CACHE_TTL = 300000;

export type { NarrativeAnalysis };

const NARRATIVE_KEYWORDS: Record<string, string[]> = {
  "AI agents": ["ai", "agent", "neural", "gpt", "llm", "openai", "anthropic", "claude", "gemini", "autonomous", "machine learning", "deep learning"],
  "PolitiFi": ["trump", "biden", "maga", "politi", "president", "election", "vote", "democrat", "republican", "congress", "senate", "white house"],
  "Cat coins": ["cat", "kitty", "kitten", "meow", "nyan", "feline", "whiskers", "purr", "tabby", "siamese"],
  "Dog coins": ["dog", "doge", "shib", "puppy", "woof", "bark", "canine", "poodle", "retriever", "husky"],
  "RWA tokenization": ["rwa", "tokenized", "real world", "real-world", "asset", "treasury", "bond", "stock", "equity", "commodity"],
  "DePIN": ["depin", "decentralized infrastructure", "iot", "sensor", "network", "node", "wireless", "5g", "helium"],
  "Political memes": ["political", "politi", "meme", "satire", "joke", "funny", "viral"],
  "Gaming": ["game", "gaming", "play", "p2e", "metaverse", "virtual", "vr", "ar", "gamer"],
  "NFT": ["nft", "jpeg", "collectible", "art", "pfp", "bored ape", "crypto punk"],
  "DeFi": ["defi", "yield", "farming", "staking", "liquidity", "swap", "dex", "amm", "lending"],
  "Layer 2": ["l2", "layer 2", "rollup", "optimistic", "zk", "zkp", "arbitrum", "optimism", "polygon"],
  "Meme": ["meme", "doge", "pepe", " Wojak", "feels", "chad", "sigma", "grug"],
};

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

  const pfSummary = pf.slice(0, 15).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    market_cap: t.market_cap || 0,
    holder_count: t.holders || 0,
    description: "",
  }));

  const lcSummary = lc.slice(0, 15).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    social_sentiment: 50,
    social_mentions: t.holders || 0,
    volume_24h: t.volume_24h || 0,
  }));

  const analysis = await analyzeNarrative(pfSummary, lcSummary);

  cachedNarratives = analysis;
  lastNarrativeFetch = now;

  console.log(`[Narrative] Trending: ${analysis.trending_narratives.join(", ")}`);
  console.log(`[Narrative] Scores: ${JSON.stringify(analysis.theme_scores)}`);
  console.log(`[Narrative] Reasoning: ${analysis.reasoning}`);

  return analysis;
}

export function getCurrentNarrative(): NarrativeAnalysis | null {
  return cachedNarratives;
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
    const themeScore = narrativeAnalysis.theme_scores[narrative] || 50;
    const keywords = NARRATIVE_KEYWORDS[narrative] || narrative.toLowerCase().split(/\s+/);

    const matchedKeywords = keywords.filter((kw) => text.includes(kw.toLowerCase()));
    if (matchedKeywords.length > 0) {
      const matchRatio = matchedKeywords.length / Math.min(keywords.length, 5);
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
