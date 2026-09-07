import type { TokenCandidate } from "../../schemas/index.js";

function getBlockscoutApi(): string {
  return "https://robinhoodchain.blockscout.com";
}

function getBlockscoutKey(): string {
  return process.env.BLOCKSCOUT_API_KEY || "";
}

function getKeyParam(): string {
  const key = getBlockscoutKey();
  return key ? `?apikey=${key}` : "";
}

interface BlockscoutToken {
  address: string;
  symbol: string;
  name: string;
  decimals: string;
  total_supply: string;
  holders_count: number;
  exchange_rate: string;
  volume_24h: string;
  market_cap: string;
}

interface BlockscoutPool {
  address: string;
  token0: { address: string; symbol: string; name: string };
  token1: { address: string; symbol: string; name: string };
  reserve0: string;
  reserve1: string;
  volume_24h: string;
  liquidity: string;
}

export async function fetchBlockscoutTrendingTokens(limit = 20): Promise<TokenCandidate[]> {
  try {
    const base = getBlockscoutApi();

    const resp = await fetch(
      `${base}/api/v2/tokens?items_count=${limit}`,
      { signal: AbortSignal.timeout(10000) }
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

    return (data.items || [])
      .filter((token) => {
        const vol = parseFloat(token.volume_24h) || 0;
        const mcap = parseFloat(token.circulating_market_cap) || 0;
        return vol > 0 && mcap > 10000;
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
  } catch (err) {
    console.error("[Blockscout] fetch trending tokens failed:", err);
    return [];
  }
}

export async function fetchTokenHolders(
  contractAddress: string
): Promise<{ count: number; topHolderPercentage: number }> {
  try {
    const base = getBlockscoutApi();
    const keyParam = getKeyParam();

    const resp = await fetch(
      `${base}/api/v2/tokens/${contractAddress}/holders?page=1&items_count=10${keyParam}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!resp.ok) return { count: 0, topHolderPercentage: 0 };
    const data = (await resp.json()) as {
      items: Array<{ value: string; token_balance: string }>;
      holders_count: number;
    };

    const count = data.holders_count || 0;
    const totalBalance = data.items.reduce(
      (sum, h) => sum + parseFloat(h.token_balance || "0"),
      0
    );
    const topHolder = data.items[0]
      ? parseFloat(data.items[0].token_balance || "0")
      : 0;
    const topPct = totalBalance > 0 ? (topHolder / totalBalance) * 100 : 0;

    return { count, topHolderPercentage: topPct };
  } catch {
    return { count: 0, topHolderPercentage: 0 };
  }
}

export async function checkTokenSafety(
  contractAddress: string
): Promise<{
  has_freeze_authority: boolean;
  has_mint_authority: boolean;
  is_verified: boolean;
  owner_renounced: boolean;
  top_holder_pct: number;
} | null> {
  try {
    const base = getBlockscoutApi();
    const keyParam = getKeyParam();

    const contractResp = await fetch(
      `${base}/api/v2/smart-contracts/${contractAddress}${keyParam}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!contractResp.ok) return null;
    const contractData = (await contractResp.json()) as {
      is_verified: boolean;
      owner_address: string | null;
    };

    const holders = await fetchTokenHolders(contractAddress);

    return {
      has_freeze_authority: false,
      has_mint_authority: !contractData.owner_address || contractData.owner_address !== "0x0000000000000000000000000000000000000000",
      is_verified: contractData.is_verified || false,
      owner_renounced: !contractData.owner_address || contractData.owner_address === "0x0000000000000000000000000000000000000000",
      top_holder_pct: holders.topHolderPercentage,
    };
  } catch (err) {
    console.error(`[Blockscout] safety check for ${contractAddress} failed:`, err);
    return null;
  }
}

export async function getRecentTokenDeployments(
  limit = 10
): Promise<Array<{
  address: string;
  name: string;
  symbol: string;
  deployer: string;
  block_number: number;
  timestamp: number;
}>> {
  try {
    const base = getBlockscoutApi();
    const keyParam = getKeyParam();

    const resp = await fetch(
      `${base}/api/v2/smart-contracts?sort=build_timestamp&order=desc&items_count=${limit}${keyParam}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      items: Array<{
        address: { hash: string };
        name: string;
        compiler_version: string;
      }>;
    };

    return (data.items || [])
      .filter((c) => c.name && c.compiler_version?.includes("vyper") || c.compiler_version?.includes("solc"))
      .map((c) => ({
        address: c.address.hash,
        name: c.name || "Unknown",
        symbol: c.name?.substring(0, 6) || "???",
        deployer: "",
        block_number: 0,
        timestamp: Date.now(),
      }));
  } catch {
    return [];
  }
}
