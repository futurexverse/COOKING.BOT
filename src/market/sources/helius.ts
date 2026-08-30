interface HeliusTokenMetadata {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: number;
  holder_count: number | null;
  authority: {
    mint_authority: string | null;
    freeze_authority: string | null;
  };
  verified: boolean;
}

interface HeliusAssetResult {
  content?: {
    metadata?: {
      name: string;
      symbol: string;
    };
  };
  authorities?: Array<{
    address: string;
    scopes: string[];
  }>;
  compression?: {
    compressed: boolean;
  };
}

interface HeliusAssetResponse {
  jsonrpc: string;
  id: string;
  result: HeliusAssetResult;
}

const HELIUS_BASE_DEFAULT = "https://mainnet.helius-rpc.com";

function getHeliusConfig() {
  const apiKey = process.env.HELIUS_API_KEY;
  const baseUrl = process.env.HELIUS_BASE_URL || HELIUS_BASE_DEFAULT;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY is required for Helius enrichment");
  }
  return { apiKey, baseUrl };
}

export async function fetchTokenSafety(
  mint: string
): Promise<{
  has_freeze_authority: boolean;
  has_mint_authority: boolean;
  holder_count: number | null;
  verified: boolean;
} | null> {
  try {
    const { apiKey, baseUrl } = getHeliusConfig();
    const url = `${baseUrl}?api-key=${apiKey}`;

    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getAsset",
      params: {
        id: mint,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as HeliusAssetResponse;
    const asset = data.result;
    if (!asset) return null;

    const authorities = asset.authorities || [];
    const hasFreezeAuthority = authorities.some(
      (a: { address: string; scopes: string[] }) => a.scopes.includes("freeze") || a.scopes.includes("full")
    );
    const hasMintAuthority = authorities.some(
      (a: { address: string; scopes: string[] }) => a.scopes.includes("mint") || a.scopes.includes("full")
    );

    return {
      has_freeze_authority: hasFreezeAuthority,
      has_mint_authority: hasMintAuthority,
      holder_count: null,
      verified: asset.compression?.compressed ?? false,
    };
  } catch (err) {
    console.error(`Helius safety check failed for ${mint}:`, err);
    return null;
  }
}

export async function fetchHolderCount(
  mint: string
): Promise<number | null> {
  try {
    const { apiKey, baseUrl } = getHeliusConfig();
    const url = `${baseUrl}?api-key=${apiKey}`;

    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [mint],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      result?: { value: Array<{ address: string }> };
    };
    return data.result?.value?.length || null;
  } catch (err) {
    console.error(`Helius holder count failed for ${mint}:`, err);
    return null;
  }
}

export async function checkHoneypot(mint: string): Promise<boolean> {
  try {
    const safety = await fetchTokenSafety(mint);
    if (!safety) return false;
    return safety.has_freeze_authority;
  } catch {
    return false;
  }
}
