import { getTokenPrice } from "../market/sources/uniswap.js";
import { fetchTokenHolders } from "../market/sources/blockscout.js";

export interface PerformanceSnapshot {
  mint: string;
  symbol: string;
  timestamp: number;
  price: number | null;
  price_change_1h: number | null;
  price_change_24h: number | null;
  volume_24h: number | null;
  holders: number | null;
  liquidity: number | null;
  market_cap: number | null;
  pnl_from_launch: number | null;
}

export interface PerformanceAlert {
  type: "price_surge" | "price_dump" | "volume_spike" | "holder_milestone" | "new_high";
  severity: "info" | "warning" | "critical";
  message: string;
  metric: string;
  value: number;
  threshold: number;
  timestamp: number;
}

export async function getPerformanceSnapshot(
  mint: string,
  symbol: string,
  initialPrice?: number | null
): Promise<PerformanceSnapshot> {
  let holders: number | null = null;
  let price: number | null = null;

  try {
    const holderData = await fetchTokenHolders(mint);
    holders = holderData.count || null;
  } catch {
    /* ignore */
  }

  try {
    price = await getTokenPrice(mint);
  } catch {
    /* ignore */
  }

  let pnlFromLaunch: number | null = null;
  if (initialPrice && price && initialPrice > 0) {
    pnlFromLaunch = ((price - initialPrice) / initialPrice) * 100;
  }

  return {
    mint,
    symbol,
    timestamp: Date.now(),
    price,
    price_change_1h: null,
    price_change_24h: null,
    volume_24h: null,
    holders,
    liquidity: null,
    market_cap: null,
    pnl_from_launch: pnlFromLaunch,
  };
}

export function checkPerformanceAlerts(
  snapshot: PerformanceSnapshot,
  previousSnapshot?: PerformanceSnapshot
): PerformanceAlert[] {
  const alerts: PerformanceAlert[] = [];
  const now = Date.now();

  const priceThresholdPct = parseFloat(
    process.env.GUARDIAN_PRICE_ALERT_PCT || "20"
  );
  const milestones = (process.env.GUARDIAN_HOLDER_MILESTONES || "100,500,1000,5000,10000")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));

  if (snapshot.price && previousSnapshot?.price && previousSnapshot.price > 0) {
    const priceChangePct =
      ((snapshot.price - previousSnapshot.price) / previousSnapshot.price) * 100;

    if (priceChangePct >= priceThresholdPct) {
      alerts.push({
        type: "price_surge",
        severity: priceChangePct >= priceThresholdPct * 2 ? "critical" : "warning",
        message: `$${snapshot.symbol} surged ${priceChangePct.toFixed(1)}% — now at $${snapshot.price.toFixed(6)}`,
        metric: "price",
        value: snapshot.price,
        threshold: previousSnapshot.price,
        timestamp: now,
      });
    }

    if (priceChangePct <= -priceThresholdPct) {
      alerts.push({
        type: "price_dump",
        severity: priceChangePct <= -priceThresholdPct * 2 ? "critical" : "warning",
        message: `$${snapshot.symbol} dumped ${priceChangePct.toFixed(1)}% — now at $${snapshot.price.toFixed(6)}`,
        metric: "price",
        value: snapshot.price,
        threshold: previousSnapshot.price,
        timestamp: now,
      });
    }
  }

  if (snapshot.holders) {
    for (const milestone of milestones) {
      if (
        previousSnapshot?.holders &&
        previousSnapshot.holders < milestone &&
        snapshot.holders >= milestone
      ) {
        alerts.push({
          type: "holder_milestone",
          severity: "info",
          message: `$${snapshot.symbol} reached ${milestone} holders!`,
          metric: "holders",
          value: snapshot.holders,
          threshold: milestone,
          timestamp: now,
        });
      }
    }
  }

  if (snapshot.pnl_from_launch !== null && snapshot.pnl_from_launch > 100) {
    alerts.push({
      type: "new_high",
      severity: "info",
      message: `$${snapshot.symbol} is up ${snapshot.pnl_from_launch.toFixed(0)}% from launch price`,
      metric: "pnl",
      value: snapshot.pnl_from_launch,
      threshold: 100,
      timestamp: now,
    });
  }

  return alerts;
}
