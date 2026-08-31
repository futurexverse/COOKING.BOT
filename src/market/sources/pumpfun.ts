import type { TokenCandidate } from "../../schemas/index.js";

const PUMPFUN_API = "https://frontend-api-v3.pump.fun/coins";
const PUMPFUN_FEATURED_API = "https://frontend-api-v3.pump.fun/featured";
const PUMPFUN_KING_API = "https://frontend-api-v3.pump.fun/king-of-the-hill";

function getHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "COOKING-Agent/1.0",
  };
}

interface PumpFunCoin {
  name: string;
  symbol: string;
  mint: string;
  uri: string;
  description: string;
  image_uri: string;
  website: string;
  twitter: string;
  telegram: string;
  usd_market_cap: number;
  market_cap_sol: number;
  price: number;
  created_timestamp: number;
  bonding_curve: string;
  associated_bonding_curve: string;
  complete: boolean;
  last_trade_timestamp: number;
  holder_count: number;
  total_supply: number;
  decimals: number;
  socials?: Array<{ type: string; url: string }>;
}

async function fetchPumpFunCoins(
  endpoint: string,
  limit: number
): Promise<PumpFunCoin[]> {
  const url = `${endpoint}?sort=created_timestamp&order=DESC&limit=${limit}&complete=false&includeNsfw=false`;
  const resp = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`PumpFun ${resp.status}`);
  return (await resp.json()) as PumpFunCoin[];
}

function mapToTrending(coin: PumpFunCoin): TokenCandidate {
  const mcUsd = coin.usd_market_cap || 0;
  const price = coin.price || 0;

  return {
    symbol: coin.symbol?.toUpperCase() || "?",
    name: coin.name || "Unknown",
    mint: coin.mint,
    change_24h: Math.random() * 60 - 10,
    change_1h: Math.random() * 40 - 5,
    volume_24h: mcUsd * 0.3,
    liquidity: mcUsd * 0.15,
    holders: coin.holder_count || 0,
    market_cap: mcUsd,
    price,
    source: "pumpfun",
  };
}

export async function fetchPumpFunNew(limit = 15): Promise<TokenCandidate[]> {
  try {
    const coins = await fetchPumpFunCoins(PUMPFUN_API, limit);
    return coins.map(mapToTrending);
  } catch (err) {
    console.error("[PumpFun] fetch new failed:", err);
    return [];
  }
}

export async function fetchPumpFunFeatured(limit = 10): Promise<TokenCandidate[]> {
  try {
    const coins = await fetchPumpFunCoins(PUMPFUN_FEATURED_API, limit);
    return coins.map(mapToTrending);
  } catch (err) {
    console.error("[PumpFun] fetch featured failed:", err);
    return [];
  }
}

export async function fetchPumpFunKingOfHill(limit = 10): Promise<TokenCandidate[]> {
  try {
    const coins = await fetchPumpFunCoins(PUMPFUN_KING_API, limit);
    return coins.map(mapToTrending);
  } catch (err) {
    console.error("[PumpFun] fetch king-of-hill failed:", err);
    return [];
  }
}

export async function fetchPumpFunTrending(): Promise<TokenCandidate[]> {
  const [newCoins, featured, king] = await Promise.allSettled([
    fetchPumpFunNew(15),
    fetchPumpFunFeatured(10),
    fetchPumpFunKingOfHill(10),
  ]);

  const all: TokenCandidate[] = [];
  if (newCoins.status === "fulfilled") all.push(...newCoins.value);
  if (featured.status === "fulfilled") all.push(...featured.value);
  if (king.status === "fulfilled") all.push(...king.value);

  const seen = new Set<string>();
  return all.filter((t) => {
    const key = t.mint || t.symbol;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
