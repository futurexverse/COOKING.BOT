import { fetchUniswapTopPools, fetchDexscreenerRobinhood } from "./sources/uniswap.js";
import { fetchBirdeyeTrending } from "./sources/birdeye.js";
import { fetchPumpFunTrending } from "./sources/pumpfun.js";
import { fetchRaydiumTrending } from "./sources/raydium.js";
import { analyzeNarrative, type NarrativeAnalysis, type NarrativeToken } from "./sources/openai.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const CALLED_TOKENS_FILE = join(ROOT_DIR, "data", "called_tokens.json");

let cachedNarratives: NarrativeAnalysis | null = null;
let lastNarrativeFetch = 0;
const NARRATIVE_CACHE_TTL = 1800000;

const recentNarratives: string[] = [];
const MAX_RECENT = 15;

let calledTokens: string[] = [];

function loadCalledTokens(): void {
  try {
    if (existsSync(CALLED_TOKENS_FILE)) {
      calledTokens = JSON.parse(readFileSync(CALLED_TOKENS_FILE, "utf-8"));
    }
  } catch {}
}

function saveCalledTokens(): void {
  const dir = dirname(CALLED_TOKENS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CALLED_TOKENS_FILE, JSON.stringify(calledTokens, null, 2));
}

function addCalledTokens(tokens: NarrativeToken[]): void {
  for (const t of tokens) {
    const addr = t.address.toLowerCase();
    if (!calledTokens.includes(addr)) {
      calledTokens.push(addr);
    }
  }
  saveCalledTokens();
}

function getCalledTokens(): string[] {
  return [...calledTokens];
}

loadCalledTokens();

export type { NarrativeAnalysis, NarrativeToken };
export { getCalledTokens };

const NARRATIVE_KEYWORDS: Record<string, string[]> = {
  "AI agents": ["ai", "agent", "neural", "gpt", "llm", "openai", "anthropic", "claude", "autonomous", "machine learning"],
  "AI trading bots": ["trading bot", "trading ai", "auto trade", "quant", "algorithmic"],
  "AI companions": ["companion", "virtual girlfriend", "ai friend", "chatbot", "character ai"],
  "PolitiFi": ["trump", "biden", "maga", "politi", "president", "election", "vote", "democrat", "republican"],
  "Cat coins": ["cat", "kitty", "kitten", "meow", "nyan", "feline", "whiskers", "purr"],
  "Dog coins": ["dog", "doge", "shib", "puppy", "woof", "bark", "canine"],
  "RWA tokenization": ["rwa", "tokenized", "real world", "asset", "treasury", "bond", "stock"],
  "DePIN": ["depin", "decentralized infrastructure", "iot", "sensor", "network", "node", "wireless"],
  "Gaming": ["game", "gaming", "play", "p2e", "metaverse", "virtual", "vr", "ar"],
  "DeFi": ["defi", "yield", "farming", "staking", "liquidity", "swap", "dex", "lending"],
  "SocialFi": ["social", "socialfi", "friend", "network", "community", "dao"],
  "Restaking": ["restaking", "lrt", "liquid restaking", "eigenlayer"],
  "Meme coins": ["meme", "pepe", "wojak", "chad", "sigma", "grug", "feels"],
  "Political memes": ["political", "politi", "meme", "satire", "joke", "funny"],
  "Animal coins": ["animal", "bear", "bull", "frog", "shark", "whale", "ape"],
  "NFT": ["nft", "jpeg", "collectible", "art", "pfp"],
  "Layer 2": ["l2", "layer 2", "rollup", "optimism", "arbitrum", "zk"],
};

export async function refreshNarratives(): Promise<NarrativeAnalysis> {
  const now = Date.now();
  if (cachedNarratives && now - lastNarrativeFetch < NARRATIVE_CACHE_TTL) {
    return cachedNarratives;
  }

  console.log("[Narrative] Fetching trending tokens from multiple sources...");

  const [dexTokens, dexRobinhood, birdeyeRobinhood, birdeyeSolana, pumpfunTokens, raydiumTokens] = await Promise.allSettled([
    fetchUniswapTopPools(50),
    fetchDexscreenerRobinhood(30),
    fetchBirdeyeTrending("robinhood", 30),
    fetchBirdeyeTrending("solana", 30),
    fetchPumpFunTrending(),
    fetchRaydiumTrending(30),
  ]);

  const allTokens = [
    ...(dexTokens.status === "fulfilled" ? dexTokens.value : []),
    ...(dexRobinhood.status === "fulfilled" ? dexRobinhood.value : []),
    ...(birdeyeRobinhood.status === "fulfilled" ? birdeyeRobinhood.value : []),
    ...(birdeyeSolana.status === "fulfilled" ? birdeyeSolana.value : []),
    ...(pumpfunTokens.status === "fulfilled" ? pumpfunTokens.value : []),
    ...(raydiumTokens.status === "fulfilled" ? raydiumTokens.value : []),
  ];

  console.log(`[Narrative] Got ${allTokens.length} tokens total (Dexscreener: ${dexTokens.status === "fulfilled" ? dexTokens.value.length : 0}, Robinhood: ${dexRobinhood.status === "fulfilled" ? dexRobinhood.value.length : 0}, Birdeye-RH: ${birdeyeRobinhood.status === "fulfilled" ? birdeyeRobinhood.value.length : 0}, Birdeye-SOL: ${birdeyeSolana.status === "fulfilled" ? birdeyeSolana.value.length : 0}, PumpFun: ${pumpfunTokens.status === "fulfilled" ? pumpfunTokens.value.length : 0}, Raydium: ${raydiumTokens.status === "fulfilled" ? raydiumTokens.value.length : 0})`);

  if (allTokens.length === 0) {
    console.log("[Narrative] No token data available, using cached or fallback");
    if (cachedNarratives) return cachedNarratives;
    return fallbackAnalysis();
  }

  const seen = new Set<string>();
  const deduped = allTokens.filter(t => {
    if (!t.mint) return false;
    const key = t.mint.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const filtered = deduped.filter(t => {
    const mc = t.market_cap || 0;
    return mc >= 10000 && mc <= 500000;
  });

  console.log(`[Narrative] ${filtered.length} tokens after dedup + $10K-$500K filter`);

  const tokensForAnalysis = filtered.length > 0 ? filtered : deduped;

  const tokenSummary = tokensForAnalysis.slice(0, 30).map((t) => ({
    symbol: t.symbol,
    name: t.name || "",
    address: t.mint || "",
    chain: t.chain || "unknown",
    volume_24h: t.volume_24h || 0,
    market_cap: t.market_cap || 0,
    holders: t.holders || 0,
    change_24h: t.change_24h || 0,
  }));

  tokenSummary.sort((a, b) => b.volume_24h - a.volume_24h);

  const calledTokensList = getCalledTokens();

  const analysis = await analyzeNarrative(tokenSummary, calledTokensList, recentNarratives);

  for (const [narrative, tokens] of Object.entries(analysis.tokens_per_narrative)) {
    addCalledTokens(tokens);
  }

  for (const narrative of analysis.trending_narratives) {
    if (!recentNarratives.includes(narrative)) {
      recentNarratives.push(narrative);
    }
  }
  while (recentNarratives.length > MAX_RECENT) {
    recentNarratives.shift();
  }

  cachedNarratives = analysis;
  lastNarrativeFetch = now;

  console.log(`[Narrative] Trending: ${analysis.trending_narratives.join(", ")}`);
  console.log(`[Narrative] Scores: ${JSON.stringify(analysis.theme_scores)}`);
  for (const [narrative, tokens] of Object.entries(analysis.tokens_per_narrative)) {
    console.log(`  ${narrative}: ${tokens.map(t => `${t.symbol} (${t.address.slice(0, 8)}...) MC:$${t.market_cap}`).join(", ")}`);
  }
  console.log(`[Narrative] Reasoning: ${analysis.reasoning}`);
  console.log(`[Narrative] Total called tokens: ${calledTokens.length}`);

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
    tokens_per_narrative: {},
    reasoning: "Default analysis — live data unavailable.",
  };
}
