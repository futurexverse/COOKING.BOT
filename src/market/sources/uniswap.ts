import type { TokenCandidate } from "../../schemas/index.js";

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

const CHAIN_NAMES: Record<string, string> = {
  solana: "Solana",
  ethereum: "Ethereum",
  base: "Base",
  bsc: "BSC",
  arbitrum: "Arbitrum",
  polygon: "Polygon",
  avalanche: "Avalanche",
  optimism: "Optimism",
  tron: "Tron",
  sui: "Sui",
  aptos: "Aptos",
};

const SUPPORTED_CHAINS = new Set([
  "solana", "ethereum", "base", "bsc", "arbitrum",
  "polygon", "avalanche", "optimism", "tron", "sui", "aptos",
]);

export async function fetchUniswapTopPools(limit = 20): Promise<TokenCandidate[]> {
  try {
    const boostResp = await fetch(
      "https://api.dexscreener.com/token-boosts/top/v1",
      { signal: AbortSignal.timeout(10000) }
    );

    if (!boostResp.ok) throw new Error(`Dexscreener boosts ${boostResp.status}`);
    const boostData = await boostResp.json() as DexscreenerBoost[] | { value: DexscreenerBoost[] };
    const boosts: DexscreenerBoost[] = Array.isArray(boostData) ? boostData : (boostData as { value: DexscreenerBoost[] }).value || [];

    const trending = boosts
      .filter((t) => SUPPORTED_CHAINS.has(t.chainId))
      .slice(0, 50);

    if (trending.length === 0) {
      console.log("[Dexscreener] No trending tokens from supported chains");
      return [];
    }

    const grouped = new Map<string, string[]>();
    for (const t of trending) {
      if (!grouped.has(t.chainId)) grouped.set(t.chainId, []);
      grouped.get(t.chainId)!.push(t.tokenAddress);
    }

    const results: TokenCandidate[] = [];

    for (const [chainId, addresses] of grouped) {
      try {
        const addrStr = addresses.slice(0, 20).join(",");
        const detailResp = await fetch(
          `https://api.dexscreener.com/tokens/v1/${chainId}/${addrStr}`,
          { signal: AbortSignal.timeout(15000) }
        );

        if (!detailResp.ok) continue;
        const detailData = await detailResp.json() as DexscreenerPair[] | { value: DexscreenerPair[] };
        const pairs: DexscreenerPair[] = Array.isArray(detailData) ? detailData : (detailData as { value: DexscreenerPair[] }).value || [];

        const bestByVolume = new Map<string, DexscreenerPair>();
        for (const pair of pairs) {
          if (pair.chainId !== chainId) continue;
          const addr = pair.baseToken.address.toLowerCase();
          const existing = bestByVolume.get(addr);
          if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
            bestByVolume.set(addr, pair);
          }
        }

        for (const pair of bestByVolume.values()) {
          const vol = pair.volume?.h24 || 0;
          const liq = pair.liquidity?.usd || 0;
          const mc = pair.marketCap || pair.fdv || 0;
          if (vol < 10000 || liq < 5000) continue;

          // Filter: mid-cap only ($100K - $10M)
          if (mc > 10000000) continue; // Skip big tokens
          if (mc < 100000 && mc > 0) continue; // Skip micro caps
          if (mc === 0) continue; // Skip unknown market cap

          results.push({
            symbol: pair.baseToken.symbol?.toUpperCase() || "?",
            name: pair.baseToken.name || "Unknown",
            mint: pair.baseToken.address,
            chain: chainId,
            change_24h: pair.priceChange?.h24 || 0,
            change_1h: pair.priceChange?.h1 || 0,
            volume_24h: vol,
            liquidity: liq,
            holders: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
            market_cap: pair.marketCap || pair.fdv || 0,
            price: parseFloat(pair.priceUsd) || 0,
            source: "dexscreener" as const,
          });
        }
      } catch (err) {
        console.error(`[Dexscreener] Failed to fetch ${chainId} tokens:`, err);
      }
    }

    results.sort((a, b) => b.volume_24h - a.volume_24h);
    const sliced = results.slice(0, limit);

    console.log(`[Dexscreener] Got ${sliced.length} trending tokens across ${grouped.size} chains`);
    for (const [chainId] of grouped) {
      const chainTokens = sliced.filter((t) => t.chain === chainId);
      if (chainTokens.length > 0) {
        console.log(`  ${CHAIN_NAMES[chainId] || chainId}: ${chainTokens.length} tokens (top: $${chainTokens[0].symbol}, $${(chainTokens[0].volume_24h / 1e6).toFixed(1)}M vol)`);
      }
    }

    return sliced;
  } catch (err) {
    console.error("[Dexscreener] fetch failed:", err);
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
    const base = "https://robinhoodchain.blockscout.com";
    const tokenResp = await fetch(
      `${base}/api/v2/tokens/${contractAddress}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!tokenResp.ok) return null;
    const tokenData = await tokenResp.json() as {
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
    const data = await resp.json() as DexscreenerPair[] | { value: DexscreenerPair[] };
    const pairs: DexscreenerPair[] = Array.isArray(data) ? data : (data as { value: DexscreenerPair[] }).value || [];
    if (pairs.length === 0) return null;
    return parseFloat(pairs[0].priceUsd) || null;
  } catch {
    return null;
  }
}
