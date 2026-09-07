const NOXA_API = "https://fun.noxa.fi/api";
const NOXA_GRAPH = "https://api.studio.thegraph.com/query/robinhood-chain/noxa";

interface NoxaToken {
  address: string;
  name: string;
  symbol: string;
  image: string;
  description: string;
  created_at: string;
  market_cap: number;
  volume_24h: number;
  price: number;
  price_change_24h: number;
  holders: number;
  website: string;
  twitter: string;
  telegram: string;
  pool_address: string;
}

interface NoxaLaunch {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
  telegram: string;
}

function getRpcUrl(): string {
  return process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
}

function getPrivateKey(): string {
  return process.env.WALLET_PRIVATE_KEY || "";
}

export async function fetchNofxaRecentLaunches(limit = 15): Promise<NoxaToken[]> {
  try {
    const resp = await fetch(`${NOXA_API}/coins?sort=created_at&order=desc&limit=${limit}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`NOXA ${resp.status}`);
    const data = (await resp.json()) as { data: NoxaToken[] };
    return data.data || [];
  } catch (err) {
    console.error("[NOXA] fetch recent launches failed:", err);
    return [];
  }
}

export async function fetchNofxaFeatured(limit = 10): Promise<NoxaToken[]> {
  try {
    const resp = await fetch(`${NOXA_API}/coins?sort=volume_24h&order=desc&limit=${limit}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`NOXA ${resp.status}`);
    const data = (await resp.json()) as { data: NoxaToken[] };
    return data.data || [];
  } catch (err) {
    console.error("[NOXA] fetch featured failed:", err);
    return [];
  }
}

export async function launchTokenViaNofxa(
  launchData: NoxaLaunch
): Promise<{
  success: boolean;
  token_address?: string;
  pool_address?: string;
  tx_hash?: string;
  error?: string;
} | null> {
  const pk = getPrivateKey();
  if (!pk) {
    console.error("[NOXA] No WALLET_PRIVATE_KEY set");
    return null;
  }

  try {
    const resp = await fetch(`${NOXA_API}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...launchData,
        private_key: pk,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[NOXA] launch failed ${resp.status}:`, err);
      return { success: false, error: err };
    }

    const data = (await resp.json()) as {
      token_address: string;
      pool_address: string;
      tx_hash: string;
    };

    return {
      success: true,
      token_address: data.token_address,
      pool_address: data.pool_address,
      tx_hash: data.tx_hash,
    };
  } catch (err) {
    console.error("[NOXA] launch error:", err);
    return { success: false, error: (err as Error).message };
  }
}

export async function fetchNofxaTokenDetails(
  address: string
): Promise<NoxaToken | null> {
  try {
    const resp = await fetch(`${NOXA_API}/coins/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as NoxaToken;
    return data;
  } catch {
    return null;
  }
}

export function isNofxaAvailable(): boolean {
  return !!getPrivateKey();
}
