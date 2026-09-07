import type { TokenCandidate } from "../../schemas/index.js";

function getBlockscoutApi(): string {
  return "https://robinhoodchain.blockscout.com";
}

interface DexscreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number };
  priceChange: { h24: number; h6: number; h1: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  txns: { h24: { buys: number; sells: number } };
}

interface DexscreenerBoost {
  chainId: string;
  tokenAddress: string;
  description?: string;
  totalAmount?: number;
}

interface DexscreenerResponse {
  value: DexscreenerPair[];
  Count: number;
}

interface DexscreenerBoostResponse {
  value: DexscreenerBoost[];
  Count: number;
}

export async function fetchUniswapTopPools(limit = 20): Promise<TokenCandidate[]> {
  try {
    const boostResp = await fetch(
      "https://api.dexscreener.com/token-boosts/top/v1",
      { signal: AbortSignal.timeout(10000) }
    );

    if (!boostResp.ok) throw new Error(`Dexscreener boosts ${boostResp.status}`);
    const boostData = (await boostResp.json()) as DexscreenerBoostResponse;
    const boosts = boostData.value || boostData as unknown as DexscreenerBoost[];

    const rhBoosts = boosts
      .filter((t) => t.chainId === "robinhood")
      .slice(0, limit);

    if (rhBoosts.length === 0) {
      console.log("[Uniswap/Dexscreener] No Robinhood tokens in boost list, using Blockscout fallback");
      return fetchFromBlockscout(limit);
    }

    const tokenAddresses = rhBoosts.map((t) => t.tokenAddress).join(",");
    const detailResp = await fetch(
      `https://api.dexscreener.com/tokens/v1/robinhood/${tokenAddresses}`,
      { signal: AbortSignal.timeout(15000) }
    );

    if (!detailResp.ok) {
      console.log(`[Uniswap/Dexscreener] Detail fetch failed ${detailResp.status}, using Blockscout fallback`);
      return fetchFromBlockscout(limit);
    }

    const detailData = (await detailResp.json()) as DexscreenerResponse | DexscreenerPair[];
    const pairs: DexscreenerPair[] = Array.isArray(detailData)
      ? detailData
      : (detailData as DexscreenerResponse).value || [];

    const bestByVolume = new Map<string, DexscreenerPair>();
    for (const pair of pairs) {
      if (pair.chainId !== "robinhood") continue;
      const addr = pair.baseToken.address.toLowerCase();
      const existing = bestByVolume.get(addr);
      if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
        bestByVolume.set(addr, pair);
      }
    }

    if (bestByVolume.size === 0) {
      console.log("[Uniswap/Dexscreener] No Robinhood pairs in detail response, using Blockscout fallback");
      return fetchFromBlockscout(limit);
    }

    const result = Array.from(bestByVolume.values())
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
        holders: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
        market_cap: pair.marketCap || pair.fdv || 0,
        price: parseFloat(pair.priceUsd) || 0,
        source: "uniswap" as const,
      }));

    console.log(`[Uniswap/Dexscreener] Got ${result.length} Robinhood tokens from Dexscreener`);
    return result;
  } catch (err) {
    console.error("[Uniswap/Dexscreener] fetch failed, trying Blockscout:", err);
    return fetchFromBlockscout(limit);
  }
}

async function fetchFromBlockscout(limit = 20): Promise<TokenCandidate[]> {
  try {
    const base = getBlockscoutApi();
    const resp = await fetch(
      `${base}/api/v2/tokens?items_count=${limit}`,
      { signal: AbortSignal.timeout(12000) }
    );

    if (!resp.ok) throw new Error(`Blockscout ${resp.status}`);
    const data = (await resp.json()) as {
      items: Array<{
        address_hash: string;
        symbol: string;
        name: string;
        decimals: string;
        total_supply: string;
        holders_count: string;
        exchange_rate: string;
        volume_24h: string;
        circulating_market_cap: string;
      }>;
    };

    const result = (data.items || [])
      .filter((t) => {
        const vol = parseFloat(t.volume_24h) || 0;
        const mcap = parseFloat(t.circulating_market_cap) || 0;
        return vol > 50000 && mcap > 10000;
      })
      .map((token) => ({
        symbol: token.symbol?.toUpperCase() || "?",
        name: token.name || "Unknown",
        mint: token.address_hash,
        change_24h: 0,
        change_1h: 0,
        volume_24h: parseFloat(token.volume_24h) || 0,
        liquidity: (parseFloat(token.circulating_market_cap) || 0) * 0.1,
        holders: parseInt(token.holders_count) || 0,
        market_cap: parseFloat(token.circulating_market_cap) || 0,
        price: parseFloat(token.exchange_rate) || 0,
        source: "blockscout" as const,
      }));

    console.log(`[Blockscout] Got ${result.length} tokens from Blockscout explorer`);
    return result;
  } catch (err) {
    console.error("[Blockscout] fetch tokens failed:", err);
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
    const data = (await resp.json()) as DexscreenerResponse | DexscreenerPair[];
    const pairs: DexscreenerPair[] = Array.isArray(data) ? data : (data as DexscreenerResponse).value || [];
    if (pairs.length === 0) return null;
    return parseFloat(pairs[0].priceUsd) || null;
  } catch {
    return null;
  }
}
