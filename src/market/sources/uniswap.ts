import type { TokenCandidate } from "../../schemas/index.js";

const DEXSCREENER_ROBINHOOD = "https://api.dexscreener.com/latest/dex/search?q=chain:robinhood";

function getBlockscoutApi(): string {
  return "https://robinhoodchain.blockscout.com";
}

function getBlockscoutKey(): string {
  return process.env.BLOCKSCOUT_API_KEY || "";
}

interface DexscreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number };
  priceChange: { h24: number; h6: number; h1: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  txns: { h24: { buys: number; sells: number } };
}

export async function fetchUniswapTopPools(limit = 20): Promise<TokenCandidate[]> {
  try {
    const resp = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/boosted/top/v1",
      { signal: AbortSignal.timeout(10000) }
    );

    if (!resp.ok) throw new Error(`Dexscreener ${resp.status}`);
    const data = (await resp.json()) as Array<{ chainId: string; tokenAddress: string }>;

    const rhTokens = data.filter((t) => t.chainId === "robinhood").slice(0, limit);

    if (rhTokens.length === 0) {
      const allResp = await fetch(
        "https://api.dexscreener.com/latest/dex/tokens/0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
        { signal: AbortSignal.timeout(10000) }
      );
      if (!allResp.ok) return [];
      const allData = (await allResp.json()) as { pairs: DexscreenerPair[] };
      const rhPairs = (allData.pairs || []).filter((p) => p.chainId === "robinhood");

      return rhPairs.slice(0, limit).map((pair) => ({
        symbol: pair.baseToken.symbol?.toUpperCase() || "?",
        name: pair.baseToken.name || "Unknown",
        mint: pair.baseToken.address,
        change_24h: pair.priceChange?.h24 || 0,
        change_1h: pair.priceChange?.h1 || 0,
        volume_24h: pair.volume?.h24 || 0,
        liquidity: pair.liquidity?.usd || 0,
        holders: pair.txns?.h24?.buys + pair.txns?.h24?.sells || 0,
        market_cap: pair.marketCap || pair.fdv || 0,
        price: parseFloat(pair.priceUsd) || 0,
        source: "uniswap" as const,
      }));
    }

    const tokenAddresses = rhTokens.map((t) => t.tokenAddress).join(",");
    const detailResp = await fetch(
      `https://api.dexscreener.com/tokens/v1/robinhood/${tokenAddresses}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!detailResp.ok) return [];
    const pairs = (await detailResp.json()) as DexscreenerPair[];

    const bestByVolume = new Map<string, DexscreenerPair>();
    for (const pair of pairs) {
      const addr = pair.baseToken.address.toLowerCase();
      const existing = bestByVolume.get(addr);
      if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
        bestByVolume.set(addr, pair);
      }
    }

    return Array.from(bestByVolume.values())
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
      .slice(0, limit)
      .map((pair) => ({
        symbol: pair.baseToken.symbol?.toUpperCase() || "?",
        name: pair.baseToken.name || "Unknown",
        mint: pair.baseToken.address,
        change_24h: pair.priceChange?.h24 || 0,
        change_1h: pair.priceChange?.h1 || 0,
        volume_24h: pair.volume?.h24 || 0,
        liquidity: pair.liquidity?.usd || 0,
        holders: pair.txns?.h24?.buys + pair.txns?.h24?.sells || 0,
        market_cap: pair.marketCap || pair.fdv || 0,
        price: parseFloat(pair.priceUsd) || 0,
        source: "uniswap" as const,
      }));
  } catch (err) {
    console.error("[Uniswap/Dexscreener] fetch top pools failed:", err);
    return [];
  }
}

export async function fetchTokenDataFromBlockscout(
  contractAddress: string
): Promise<{
  balance: string;
  holders: number;
  totalSupply: string;
  decimals: number;
} | null> {
  try {
    const base = getBlockscoutApi();

    const tokenResp = await fetch(
      `${base}/api/v2/tokens/${contractAddress}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!tokenResp.ok) return null;
    const tokenData = (await tokenResp.json()) as {
      holders_count: number;
      total_supply: string;
      decimals: string;
    };

    return {
      balance: "0",
      holders: tokenData.holders_count || 0,
      totalSupply: tokenData.total_supply || "0",
      decimals: parseInt(tokenData.decimals) || 18,
    };
  } catch (err) {
    console.error(`[Blockscout] token data for ${contractAddress} failed:`, err);
    return null;
  }
}

export async function getTokenPrice(
  contractAddress: string
): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/tokens/v1/robinhood/${contractAddress}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!resp.ok) return null;
    const data = (await resp.json()) as DexscreenerPair[];
    if (data.length === 0) return null;
    return parseFloat(data[0].priceUsd) || null;
  } catch {
    return null;
  }
}
