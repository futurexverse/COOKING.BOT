import type { TokenCandidate } from "../../schemas/index.js";

interface JupiterToken {
  id: string;
  name: string;
  symbol: string;
  mint: string;
 _decimals: number;
  di_24h: number;
  dc_24h: number;
  di_1h: number;
  dc_1h: number;
  volume_24h: number;
  volume_1h: number;
  total_trade_24h: number;
  unique_wallets_24h: number;
  holder_count: number;
}

interface JupiterTrendingResponse {
  tokens: JupiterToken[];
}

const JUPITER_BASE = "https://tokens.jup.ag";

export async function fetchJupiterTrending(
  limit: number = 50
): Promise<TokenCandidate[]> {
  const apiKey = process.env.JUPITER_API_KEY;
  const url = `${JUPITER_BASE}/v2/trending?limit=${limit}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Jupiter API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as JupiterTrendingResponse;

  return data.tokens.map((token) => ({
    symbol: token.symbol,
    name: token.name,
    mint: token.mint,
    change_24h: token.dc_24h || 0,
    change_1h: token.dc_1h || 0,
    volume_24h: token.volume_24h || 0,
    volume_1h: token.volume_1h || 0,
    liquidity: 0,
    holders: token.holder_count || token.unique_wallets_24h || 0,
    source: "jupiter" as const,
  }));
}

export async function fetchJupiterPrice(
  mint: string
): Promise<{ price: number; change_24h: number } | null> {
  const url = `https://api.jup.ag/price/v2?ids=${mint}`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    data: Record<string, { price: number; change_24h: number }>;
  };
  const entry = data.data[mint];
  if (!entry) return null;

  return { price: entry.price, change_24h: entry.change_24h };
}
