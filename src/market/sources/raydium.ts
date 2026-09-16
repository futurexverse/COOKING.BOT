import type { TokenCandidate } from "../../schemas/index.js";

const RAYDIUM_API = "https://api-v3.raydium.io";

interface RaydiumPool {
  id: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  lpMint: string;
  marketId: string;
  lpPrice: number;
  baseReserve: number;
  quoteReserve: number;
  lpSupply: number;
  openTime: string;
  status: string;
  tvl: number;
  volume24h: number;
  volume6h: number;
  volume1h: number;
  price: number;
  baseTokenName: string;
  baseTokenSymbol: string;
  quoteTokenSymbol: string;
}

interface RaydiumPoolsResponse {
  id: string;
  success: boolean;
  data: {
    data: RaydiumPool[];
  };
}

export async function fetchRaydiumTrending(
  limit: number = 30
): Promise<TokenCandidate[]> {
  try {
    console.log("[Raydium] Fetching Solana trending pools...");

    const url = `${RAYDIUM_API}/pools/info/latest?limit=${limit}&sort=volume24h&sortType=desc&poolType=all`;

    const resp = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "COOKING-Agent/1.0",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`[Raydium] API error ${resp.status}`);
      return [];
    }

    const data = await resp.json() as RaydiumPoolsResponse;

    if (!data.success || !data.data?.data) {
      console.error("[Raydium] Unexpected response");
      return [];
    }

    const results: TokenCandidate[] = [];

    for (const pool of data.data.data.slice(0, limit)) {
      if (!pool.baseMint || !pool.baseTokenSymbol) continue;

      // Skip stablecoin pools (USDC, USDT, SOL pairs with very high liquidity)
      const sym = pool.baseTokenSymbol.toUpperCase();
      if (["USDC", "USDT", "SOL", "WSOL", "BONK"].includes(sym)) continue;

      const vol24h = pool.volume24h || 0;
      const tvl = pool.tvl || 0;

      // Calculate approximate market cap from reserve and price
      const mc = pool.price ? tvl * 2 : 0;

      // Apply same filters: $10K-$500K MC, $1.5K vol, $5K liq
      if (mc > 0 && (mc < 10000 || mc > 500000)) continue;
      if (vol24h < 1500) continue;
      if (tvl < 5000) continue;

      results.push({
        symbol: sym,
        name: pool.baseTokenName || pool.baseTokenSymbol || "Unknown",
        mint: pool.baseMint,
        chain: "solana",
        change_24h: 0,
        change_1h: 0,
        volume_24h: vol24h,
        liquidity: tvl,
        holders: 0,
        market_cap: mc > 0 ? mc : tvl,
        price: pool.price || 0,
        source: "raydium",
      });
    }

    results.sort((a, b) => b.volume_24h - a.volume_24h);
    const sliced = results.slice(0, limit);

    console.log(`[Raydium] Got ${sliced.length} Solana tokens`);
    if (sliced.length > 0) {
      console.log(`[Raydium] Top: $${sliced[0].symbol}, Vol: $${sliced[0].volume_24h.toFixed(0)}, MC: $${sliced[0].market_cap}`);
    }

    return sliced;
  } catch (err) {
    console.error("[Raydium] Fetch failed:", err);
    return [];
  }
}
