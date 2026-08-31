import type { TokenCandidate } from "../../schemas/index.js";

const LUNARCRUSH_BASE = "https://lunacrush.com/api4/public";

function getApiKey(): string {
  return process.env.LUNARCRUSH_API_KEY || "";
}

function getHeaders(): Record<string, string> {
  const key = getApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return headers;
}

interface LunarCrushCoin {
  id: number;
  symbol: string;
  name: string;
  price: number;
  price_btc: number;
  market_cap: number;
  market_cap_rank: number;
  volume_24h: number;
  percent_change_1h: number;
  percent_change_24h: number;
  percent_change_7d: number;
  social_sentiment: number;
  social_mentions: number;
  social_contributors: number;
  social_interactions: number;
  galaxy_score: number;
  alt_rank: number;
  liquidity_usd: number;
  supply: number;
  max_supply: number;
  name_matched: boolean;
}

interface LunarCrushResponse {
  data: LunarCrushCoin[];
}

function mapToTrending(coin: LunarCrushCoin): TokenCandidate {
  const mc = coin.market_cap || 0;
  const vol = coin.volume_24h || 0;

  return {
    symbol: coin.symbol?.toUpperCase() || "?",
    name: coin.name || "Unknown",
    mint: `lunar_${coin.symbol.toLowerCase()}`,
    change_24h: coin.percent_change_24h || 0,
    change_1h: coin.percent_change_1h || 0,
    volume_24h: vol,
    liquidity: coin.liquidity_usd || mc * 0.1,
    holders: coin.social_contributors || 0,
    market_cap: mc,
    price: coin.price || 0,
    source: "lunacrush",
  };
}

export async function fetchLunarCrushTrending(limit = 10): Promise<TokenCandidate[]> {
  if (!getApiKey()) {
    console.log("[LunarCrush] No API key set, skipping");
    return [];
  }

  try {
    const url = `${LUNARCRUSH_BASE}/coins/list/v1?sort=social_mentions&limit=${limit}`;
    const resp = await fetch(url, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`LunarCrush ${resp.status}`);
    const data = (await resp.json()) as LunarCrushResponse;
    return (data.data || []).map(mapToTrending);
  } catch (err) {
    console.error("[LunarCrush] fetch trending failed:", err);
    return [];
  }
}

export async function fetchLunarCrushSocialSentiment(
  symbol: string
): Promise<{ sentiment: number; mentions: number; contributors: number } | null> {
  if (!getApiKey()) return null;

  try {
    const url = `${LUNARCRUSH_BASE}/coins/v2/${symbol}`;
    const resp = await fetch(url, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`LunarCrush ${resp.status}`);
    const data = (await resp.json()) as { data: LunarCrushCoin };
    const coin = data.data;
    return {
      sentiment: coin.social_sentiment || 50,
      mentions: coin.social_mentions || 0,
      contributors: coin.social_contributors || 0,
    };
  } catch (err) {
    console.error(`[LunarCrush] sentiment fetch for ${symbol} failed:`, err);
    return null;
  }
}

export async function fetchLunarCrushSolanaTokens(): Promise<TokenCandidate[]> {
  if (!getApiKey()) return [];

  try {
    const url = `${LUNARCRUSH_BASE}/coins/list/v1?sort=social_sentiment&limit=15&chain=solana`;
    const resp = await fetch(url, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`LunarCrush ${resp.status}`);
    const data = (await resp.json()) as LunarCrushResponse;
    return (data.data || []).map(mapToTrending);
  } catch (err) {
    console.error("[LunarCrush] fetch solana tokens failed:", err);
    return [];
  }
}
