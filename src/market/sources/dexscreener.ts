import type { TokenCandidate } from "../../schemas/index.js";

interface DexscreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    h24: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h1: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
  };
  priceChange: {
    h24: number;
    h6: number;
    h1: number;
  };
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  pairCreatedAt: number;
}

interface DexscreenerSearchResponse {
  schemaVersion: string;
  pairs: DexscreenerPair[];
}

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";

export async function fetchDexscreenerTrending(
  query: string = "solana"
): Promise<TokenCandidate[]> {
  const boostUrl = "https://api.dexscreener.com/token-boosts/top/v1";
  const boostRes = await fetch(boostUrl);

  let solanaMints: string[] = [];
  if (boostRes.ok) {
    const boosts = (await boostRes.json()) as Array<{ chainId: string; tokenAddress: string }>;
    solanaMints = boosts
      .filter((b) => b.chainId === "solana")
      .map((b) => b.tokenAddress)
      .slice(0, 30);
  }

  if (solanaMints.length === 0) {
    const url = `${DEXSCREENER_BASE}/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Dexscreener API error: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as DexscreenerSearchResponse;
    const solanaPairs = data.pairs.filter((p) => p.chainId === "solana");
    return solanaPairs.slice(0, 30).map((pair) => ({
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      mint: pair.baseToken.address,
      change_24h: pair.priceChange.h24 || 0,
      change_1h: pair.priceChange.h1 || 0,
      volume_24h: pair.volume.h24 || 0,
      volume_1h: pair.volume.h1 || 0,
      liquidity: pair.liquidity?.usd || 0,
      market_cap: pair.fdv || 0,
      price: parseFloat(pair.priceUsd) || 0,
      source: "dexscreener" as const,
    }));
  }

  const tokenPairs = await Promise.all(
    solanaMints.map(async (mint) => {
      try {
        const res = await fetch(`${DEXSCREENER_BASE}/tokens/${mint}`);
        if (!res.ok) return null;
        const data = (await res.json()) as DexscreenerSearchResponse;
        const pairs = data.pairs?.filter((p) => p.chainId === "solana") || [];
        return pairs.length > 0 ? pairs.reduce((best, p) => p.volume.h24 > best.volume.h24 ? p : best) : null;
      } catch {
        return null;
      }
    })
  );

  const validPairs = tokenPairs.filter((p): p is DexscreenerPair => p !== null);
  const bestByToken = new Map<string, DexscreenerPair>();
  for (const pair of validPairs) {
    const key = pair.baseToken.address;
    const existing = bestByToken.get(key);
    if (!existing || pair.volume.h24 > existing.volume.h24) {
      bestByToken.set(key, pair);
    }
  }

  return Array.from(bestByToken.values()).map((pair) => ({
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    mint: pair.baseToken.address,
    change_24h: pair.priceChange.h24 || 0,
    change_1h: pair.priceChange.h1 || 0,
    volume_24h: pair.volume.h24 || 0,
    volume_1h: pair.volume.h1 || 0,
    liquidity: pair.liquidity?.usd || 0,
    market_cap: pair.fdv || 0,
    price: parseFloat(pair.priceUsd) || 0,
    source: "dexscreener" as const,
  }));
}

export async function fetchDexscreenerPair(
  pairAddress: string
): Promise<DexscreenerPair | null> {
  const url = `${DEXSCREENER_BASE}/pairs/solana/${pairAddress}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as { pairs: DexscreenerPair[] };
  return data.pairs?.[0] || null;
}
