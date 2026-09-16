import type { TokenCandidate } from "../../schemas/index.js";

const BIRDEYE_BASE = "https://public-api.birdeye.so";

function getApiKey(): string {
  return process.env.BIRDEYE_API_KEY || "";
}

interface BirdeyeTrendingToken {
  address: string;
  decimals: number;
  liquidity: number;
  logoURI: string;
  name: string;
  symbol: string;
  volume24hUSD: number;
  volume24hChangePercent: number;
  rank: number;
  price: number;
  price24hChangePercent: number;
  fdv: number;
  marketcap: number;
}

interface BirdeyeTrendingResponse {
  success: boolean;
  data: {
    updateUnixTime: number;
    updateTime: string;
    total: number;
    tokens: BirdeyeTrendingToken[];
  };
}

export async function fetchBirdeyeTrending(
  chain: string = "robinhood",
  limit: number = 30
): Promise<TokenCandidate[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("[Birdeye] No BIRDEYE_API_KEY set — skipping");
    return [];
  }

  try {
    const url = `${BIRDEYE_BASE}/defi/token_trending?sort_by=rank&sort_type=desc&interval=24h&limit=${Math.min(limit, 50)}`;
    console.log(`[Birdeye] Fetching ${chain} trending...`);

    const resp = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        "x-chain": chain,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 401) {
      console.error("[Birdeye] Unauthorized — check BIRDEYE_API_KEY");
      return [];
    }

    if (!resp.ok) {
      console.error(`[Birdeye] API error ${resp.status}`);
      return [];
    }

    const data: BirdeyeTrendingResponse = await resp.json();

    if (!data.success || !data.data?.tokens) {
      console.error("[Birdeye] Unexpected response:", JSON.stringify(data).slice(0, 200));
      return [];
    }

    const results: TokenCandidate[] = [];

    for (const token of data.data.tokens.slice(0, limit)) {
      if (!token.address || !token.symbol) continue;

      results.push({
        symbol: token.symbol.toUpperCase(),
        name: token.name || token.symbol,
        mint: token.address,
        chain,
        change_24h: token.price24hChangePercent || 0,
        change_1h: 0,
        volume_24h: token.volume24hUSD || 0,
        liquidity: token.liquidity || 0,
        holders: 0,
        market_cap: token.marketcap || token.fdv || 0,
        price: token.price || 0,
        source: "birdeye" as const,
      });
    }

    console.log(`[Birdeye] Got ${results.length} ${chain} tokens`);
    if (results.length > 0) {
      console.log(`[Birdeye] Top: $${results[0].symbol}, Vol: $${results[0].volume_24h.toFixed(0)}, MC: $${results[0].market_cap}`);
    }

    return results;
  } catch (err) {
    console.error(`[Birdeye] Fetch ${chain} failed:`, err);
    return [];
  }
}
