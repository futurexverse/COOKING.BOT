import { fetchUniswapTopPools } from "./sources/uniswap.js";
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
  "Meme": ["meme", "doge", "pepe", "wojak", "feels", "chad", "sigma", "grug"],
};

export async function refreshNarratives(): Promise<NarrativeAnalysis> {
  const now = Date.now();
  if (cachedNarratives && now - lastNarrativeFetch < NARRATIVE_CACHE_TTL) {
    return cachedNarratives;
  }

  console.log("[Narrative] Fetching trending tokens from Dexscreener (all chains)...");

  let tokens: Awaited<ReturnType<typeof fetchUniswapTopPools>> = [];
  try {
    tokens = await fetchUniswapTopPools(30);
  } catch (err) {
    console.error("[Narrative] Dexscreener fetch failed:", err);
  }

  console.log(`[Narrative] Got ${tokens.length} tokens from Dexscreener`);

  if (tokens.length === 0) {
    console.log("[Narrative] No token data available, using cached or fallback");
    if (cachedNarratives) return cachedNarratives;
    return fallbackAnalysis();
  }

  const tokenSummary = tokens.slice(0, 20).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    chain: t.chain || "unknown",
    volume_24h: t.volume_24h || 0,
    market_cap: t.market_cap || 0,
    holders: t.holders || 0,
    change_24h: t.change_24h || 0,
  }));

  tokenSummary.sort((a, b) => b.volume_24h - a.volume_24h);

  const analysis = await analyzeNarrative(tokenSummary);

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

function fallbackAnalysis(): NarrativeAnalysis {
  return {
    trending_narratives: ["AI agents", "PolitiFi", "Cat coins", "RWA tokenization", "DePIN"],
    theme_scores: { "AI agents": 75, "PolitiFi": 65, "Cat coins": 60, "RWA tokenization": 50, "DePIN": 45 },
    reasoning: "Default analysis — live data unavailable.",
  };
}
