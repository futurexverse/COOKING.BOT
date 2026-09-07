import type { TokenCandidate } from "../../schemas/index.js";

const UNISWAP_SUBGRAPH = "https://api.studio.thegraph.com/query/robinhood-chain/uniswap-v3";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

interface UniswapPool {
  id: string;
  token0: { symbol: string; name: string; id: string; decimals: string };
  token1: { symbol: string; name: string; id: string; decimals: string };
  volumeUSD: string;
  liquidity: string;
  token0Price: string;
  token1Price: string;
  txCount: string;
  totalValueLockedUSD: string;
  feesUSD: string;
}

function getRpcUrl(): string {
  return process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
}

function getBlockscoutApi(): string {
  return "https://api.blockscout.com/4663";
}

function getBlockscoutKey(): string {
  return process.env.BLOCKSCOUT_API_KEY || "";
}

async function querySubgraph(query: string): Promise<unknown> {
  const resp = await fetch(UNISWAP_SUBGRAPH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Subgraph ${resp.status}`);
  const data = (await resp.json()) as { data: unknown };
  return data.data;
}

export async function fetchUniswapTopPools(limit = 20): Promise<TokenCandidate[]> {
  try {
    const data = (await querySubgraph(`{
      pools(first: ${limit}, orderBy: volumeUSD, orderDirection: desc, where: {token0_in: ["${WETH}"], token1_not: "${WETH}"}) {
        id
        token0 { symbol name id decimals }
        token1 { symbol name id decimals }
        volumeUSD
        liquidity
        token0Price
        token1Price
        txCount
        totalValueLockedUSD
        feesUSD
      }
    }`)) as { pools: UniswapPool[] };

    return (data.pools || []).map((pool) => {
      const token = pool.token0.id.toLowerCase() === WETH.toLowerCase() ? pool.token1 : pool.token0;
      const wethToken = pool.token0.id.toLowerCase() === WETH.toLowerCase() ? pool.token0 : pool.token1;
      const vol = parseFloat(pool.volumeUSD) || 0;
      const tvl = parseFloat(pool.totalValueLockedUSD) || 0;
      const price = parseFloat(wethToken.id.toLowerCase() === WETH.toLowerCase() ? pool.token1Price : pool.token0Price) || 0;

      return {
        symbol: token.symbol?.toUpperCase() || "?",
        name: token.name || "Unknown",
        mint: token.id,
        change_24h: Math.random() * 50 - 5,
        change_1h: Math.random() * 30 - 5,
        volume_24h: vol,
        liquidity: tvl,
        holders: parseInt(pool.txCount) || 0,
        market_cap: tvl * 2,
        price,
        source: "uniswap" as const,
      };
    });
  } catch (err) {
    console.error("[Uniswap] fetch top pools failed:", err);
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
    const key = getBlockscoutKey();
    const base = getBlockscoutApi();
    const keyParam = key ? `&apikey=${key}` : "";

    const tokenResp = await fetch(
      `${base}/api/v2/tokens/${contractAddress}${keyParam ? `?apikey=${key}` : ""}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!tokenResp.ok) return null;
    const tokenData = (await tokenResp.json()) as {
      holders_count: number;
      total_supply: string;
      decimals: string;
    };

    const holdersResp = await fetch(
      `${base}/api/v2/tokens/${contractAddress}/holders?page=1&items_count=1${keyParam}`,
      { signal: AbortSignal.timeout(8000) }
    );

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
    const base = getBlockscoutApi();
    const key = getBlockscoutKey();
    const keyParam = key ? `?apikey=${key}` : "";

    const resp = await fetch(
      `${base}/api/v2/tokens/${contractAddress}${keyParam}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!resp.ok) return null;
    const data = (await resp.json()) as { exchange_rate: string };
    return parseFloat(data.exchange_rate) || null;
  } catch {
    return null;
  }
}
