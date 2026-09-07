import { checkTokenSafety, fetchTokenHolders } from "../market/sources/blockscout.js";

export interface RugAlert {
  type: "freeze_authority" | "mint_authority" | "liquidity_drop" | "honeypot" | "concentrated_holders" | "low_liquidity";
  severity: "info" | "warning" | "critical";
  message: string;
  timestamp: number;
}

export async function detectRugSignals(
  mint: string,
  previousLiquidity?: number
): Promise<RugAlert[]> {
  const alerts: RugAlert[] = [];
  const now = Date.now();

  try {
    const safety = await checkTokenSafety(mint);
    if (safety) {
      if (safety.has_freeze_authority) {
        alerts.push({
          type: "freeze_authority",
          severity: "critical",
          message: `Freeze authority is ACTIVE on ${mint.slice(0, 10)}... — accounts can be frozen at any time`,
          timestamp: now,
        });
      }

      if (safety.has_mint_authority) {
        alerts.push({
          type: "mint_authority",
          severity: "critical",
          message: `Mint authority is ACTIVE on ${mint.slice(0, 10)}... — unlimited supply inflation possible`,
          timestamp: now,
        });
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const holders = await fetchTokenHolders(mint);

    if (holders.topHolderPercentage > 40) {
      alerts.push({
        type: "concentrated_holders",
        severity: "warning",
        message: `Top holder owns ${holders.topHolderPercentage.toFixed(1)}% of supply — dump risk`,
        timestamp: now,
      });
    }

    if (holders.count > 0 && holders.count < 10) {
      alerts.push({
        type: "concentrated_holders",
        severity: "warning",
        message: `Only ${holders.count} holders detected — low distribution`,
        timestamp: now,
      });
    }
  } catch {
    /* ignore */
  }

  return alerts;
}

export async function simulateSell(
  mint: string
): Promise<{ success: boolean; tax: number; error?: string }> {
  try {
    const safety = await checkTokenSafety(mint);
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
