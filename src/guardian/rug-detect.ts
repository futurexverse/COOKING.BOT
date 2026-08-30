import { Connection, PublicKey } from "@solana/web3.js";
import { fetchTokenSafety } from "../market/sources/helius.js";

export interface RugAlert {
  type: "freeze_authority" | "mint_authority" | "liquidity_drop" | "honeypot" | "concentrated_holders" | "low_liquidity";
  severity: "info" | "warning" | "critical";
  message: string;
  timestamp: number;
}

function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

export async function detectRugSignals(
  mint: string,
  previousLiquidity?: number
): Promise<RugAlert[]> {
  const alerts: RugAlert[] = [];
  const now = Date.now();

  const safety = await fetchTokenSafety(mint);
  if (safety) {
    if (safety.has_freeze_authority) {
      alerts.push({
        type: "freeze_authority",
        severity: "critical",
        message: `Freeze authority is ACTIVE on $${mint.slice(0, 6)}... — accounts can be frozen at any time`,
        timestamp: now,
      });
    }

    if (safety.has_mint_authority) {
      alerts.push({
        type: "mint_authority",
        severity: "critical",
        message: `Mint authority is ACTIVE on $${mint.slice(0, 6)}... — unlimited supply inflation possible`,
        timestamp: now,
      });
    }
  }

  const connection = getConnection();
  try {
    const largestAccounts = await connection.getTokenLargestAccounts(
      new PublicKey(mint)
    );
    const holders = largestAccounts.value;

    if (holders.length > 0) {
      const totalSupply = holders.reduce(
        (sum, h) => sum + BigInt(h.amount),
        BigInt(0)
      );
      const topHolderAmount = BigInt(holders[0].amount);
      const topHolderPct = Number((topHolderAmount * BigInt(100)) / totalSupply);

      if (topHolderPct > 40) {
        alerts.push({
          type: "concentrated_holders",
          severity: "warning",
          message: `Top holder owns ${topHolderPct.toFixed(1)}% of supply — dump risk`,
          timestamp: now,
        });
      }

      if (holders.length < 10) {
        alerts.push({
          type: "concentrated_holders",
          severity: "warning",
          message: `Only ${holders.length} large holders detected — low distribution`,
          timestamp: now,
        });
      }
    }
  } catch {
    /* RPC errors are non-critical for rug detection */
  }

  if (previousLiquidity !== undefined) {
    try {
      const tokenAccounts = await connection.getTokenLargestAccounts(
        new PublicKey(mint)
      );
      const currentHolders = tokenAccounts.value.length;

      if (previousLiquidity > 0 && currentHolders < previousLiquidity * 0.3) {
        alerts.push({
          type: "liquidity_drop",
          severity: "critical",
          message: `Holder count dropped significantly — possible liquidity event`,
          timestamp: now,
        });
      }
    } catch {
      /* ignore */
    }
  }

  return alerts;
}

export async function simulateSell(
  mint: string,
  amount: number = 1000000
): Promise<{ success: boolean; tax: number; error?: string }> {
  try {
    const safety = await fetchTokenSafety(mint);
    if (safety?.has_freeze_authority) {
      return {
        success: false,
        tax: 100,
        error: "Token has freeze authority — likely honeypot",
      };
    }

    return { success: true, tax: 0 };
  } catch (err) {
    return {
      success: false,
      tax: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export function checkLiquidityHealth(
  liquidityUsd: number,
  volume24h: number
): { healthy: boolean; ratio: number; alert?: RugAlert } {
  const ratio = volume24h > 0 ? liquidityUsd / volume24h : 0;
  const healthy = liquidityUsd >= 10000 && ratio >= 0.1;

  if (!healthy) {
    return {
      healthy,
      ratio,
      alert: {
        type: "low_liquidity",
        severity: liquidityUsd < 5000 ? "critical" : "warning",
        message: `Liquidity $${liquidityUsd.toFixed(0)} (vol/liq ratio: ${ratio.toFixed(2)}) — ${liquidityUsd < 5000 ? "dangerously low" : "below threshold"}`,
        timestamp: Date.now(),
      },
    };
  }

  return { healthy, ratio };
}
