import { Connection, PublicKey } from "@solana/web3.js";

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

function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

export async function getPerformanceSnapshot(
  mint: string,
  symbol: string,
  initialPrice?: number | null
): Promise<PerformanceSnapshot> {
  const connection = getConnection();
  let holders: number | null = null;
  let price: number | null = null;

  try {
    const largestAccounts = await connection.getTokenLargestAccounts(
      new PublicKey(mint)
    );
    holders = largestAccounts.value.length;
  } catch {
    /* ignore */
  }

  try {
    const priceData = await fetch(
      `https://api.jup.ag/price/v2?ids=${mint}`
    );
    if (priceData.ok) {
      const json = (await priceData.json()) as {
        data: Record<string, { price: number }>;
      };
      price = json.data[mint]?.price || null;
    }
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
  const volumeMultiplier = parseFloat(
    process.env.GUARDIAN_VOLUME_ALERT_MULTIPLIER || "3"
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

export function calculatePnl(
  currentPrice: number,
  launchPrice: number
): number {
  if (launchPrice <= 0) return 0;
  return ((currentPrice - launchPrice) / launchPrice) * 100;
}
