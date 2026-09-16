import type { TokenCandidate } from "../../schemas/index.js";

interface GmgnToken {
  id: number;
  chain: string;
  address: string;
  symbol: string;
  logo: string;
  price: number;
  price_change_percent: number;
  price_change_percent1m: number;
  price_change_percent5m: number;
  price_change_percent1h: number;
  swaps: number;
  volume: number;
  liquidity: number;
  market_cap: number;
  holder_count: number;
  buy_tax: string;
  sell_tax: string;
  is_honeypot: number;
  is_open_source: number;
  renounced: number;
  sniper_count: number;
  smart_degen_count: number;
  pool_creation_timestamp: number;
  open_timestamp: number;
}

interface GmgnResponse {
  code: number;
  msg: string;
  data: {
    rank: GmgnToken[];
  };
}

const GMGN_BASE = "https://gmgn.ai/defi/quotation/v1/rank";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://gmgn.ai/",
  "Origin": "https://gmgn.ai",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

export async function fetchGmgnTrending(
  chain: string = "robinhood",
  timePeriod: string = "5m",
  limit: number = 30
): Promise<TokenCandidate[]> {
  try {
    const url = `${GMGN_BASE}/${chain}/swaps/${timePeriod}?orderby=volume&direction=desc&filters[]=not_honeypot&filters[]=verified`;
    console.log(`[GMGN] Fetching ${chain} trending (${timePeriod})...`);

    const resp = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`[GMGN] API error ${resp.status}`);
      return [];
    }

    const data: GmgnResponse = await resp.json();

    if (data.code !== 0 || !data.data?.rank) {
      console.error(`[GMGN] Unexpected response:`, data.msg);
      return [];
    }

    const results: TokenCandidate[] = [];

    for (const token of data.data.rank.slice(0, limit)) {
      if (!token.address || !token.symbol) continue;

      results.push({
        symbol: token.symbol.toUpperCase(),
        name: token.symbol,
        mint: token.address,
        chain: chain === "robinhood" ? "robinhood" : chain,
        change_24h: token.price_change_percent || 0,
        change_1h: token.price_change_percent1h || 0,
        volume_24h: token.volume || 0,
        liquidity: token.liquidity || 0,
        holders: token.holder_count || 0,
        market_cap: token.market_cap || 0,
        price: token.price || 0,
        source: "gmgn" as const,
      });
    }

    console.log(`[GMGN] Got ${results.length} ${chain} tokens`);
    if (results.length > 0) {
      console.log(`[GMGN] Top: $${results[0].symbol}, Vol: $${results[0].volume_24h}, MC: $${results[0].market_cap}`);
    }

    return results;
  } catch (err) {
    console.error(`[GMGN] Fetch failed:`, err);
    return [];
  }
}
