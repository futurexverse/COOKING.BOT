import type { GuardianStatus, LaunchRecord } from "../schemas/index.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { checkTokenSafety, fetchTokenHolders } from "../market/sources/blockscout.js";
import { getTokenPrice } from "../market/sources/uniswap.js";
import { checkLpExitConditions, getPosition } from "./liquidity.js";

const DATA_DIR = process.env.ORACLE_DATA_DIR || "data";
const GUARDIAN_FILE = join(DATA_DIR, "guardian_state.json");

interface GuardianEntry {
  mint: string;
  symbol: string;
  active: boolean;
  launched_at: number;
  initial_price: number | null;
  alerts: Array<{
    type: string;
    message: string;
    timestamp: number;
    severity: "info" | "warning" | "critical";
  }>;
  last_snapshot: {
    price: number | null;
    holders: number | null;
    timestamp: number;
  } | null;
}

const guardians = new Map<string, GuardianEntry>();

function loadState(): void {
  if (existsSync(GUARDIAN_FILE)) {
    try {
      const data = JSON.parse(readFileSync(GUARDIAN_FILE, "utf-8"));
      for (const entry of data) {
        guardians.set(entry.mint, entry);
      }
    } catch {
      /* ignore */
    }
  }
}

function saveState(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  const arr = Array.from(guardians.values());
  writeFileSync(GUARDIAN_FILE, JSON.stringify(arr, null, 2));
}

loadState();

export function registerGuardian(
  mint: string,
  symbol: string,
  initialPrice?: number
): void {
  const entry: GuardianEntry = {
    mint,
    symbol,
    active: true,
    launched_at: Date.now(),
    initial_price: initialPrice || null,
    alerts: [],
    last_snapshot: null,
  };
  guardians.set(mint, entry);
  saveState();
  console.log(`[Guardian] Registered: $${symbol} (${mint.slice(0, 10)}...)`);
}

export async function runGuardianCycle(
  launch: LaunchRecord
): Promise<{
  alerts: Array<{ type: string; message: string; timestamp: number; severity: "info" | "warning" | "critical" }>;
  performanceAlerts: Array<{ type: string; message: string; timestamp: number; severity: "info" | "warning" | "critical" }>;
  lpAction: { should_exit: boolean; reason: string; exit_type?: string; pnl_pct?: number };
  snapshot: { price: number | null; holders: number | null; timestamp: number };
}> {
  const entry = guardians.get(launch.mint);
  if (!entry || !entry.active) {
    return {
      alerts: [],
      performanceAlerts: [],
      lpAction: { should_exit: false, reason: "" },
      snapshot: { price: null, holders: null, timestamp: Date.now() },
    };
  }

  console.log(`[Guardian] Running cycle for $${launch.symbol}...`);

  const alerts: Array<{ type: string; message: string; timestamp: number; severity: "info" | "warning" | "critical" }> = [];
  const performanceAlerts: Array<{ type: string; message: string; timestamp: number; severity: "info" | "warning" | "critical" }> = [];

  // Safety checks
  try {
    const safety = await checkTokenSafety(launch.mint);
    if (safety) {
      if (!safety.owner_renounced && safety.has_mint_authority) {
        const alert = {
          type: "rug_mint",
          message: `$${launch.symbol}: Owner has mint authority - possible rug`,
          timestamp: Date.now(),
          severity: "critical" as const,
        };
        alerts.push(alert);
        entry.alerts.push(alert);
      }
      if (safety.top_holder_pct > 30) {
        const alert = {
          type: "concentration",
          message: `$${launch.symbol}: Top holder owns ${safety.top_holder_pct.toFixed(1)}%`,
          timestamp: Date.now(),
          severity: "warning" as const,
        };
        alerts.push(alert);
        entry.alerts.push(alert);
      }
    }
  } catch (err) {
    console.error(`[Guardian] Safety check error for $${launch.symbol}:`, err);
  }

  // Price check
  let currentPrice: number | null = null;
  try {
    currentPrice = await getTokenPrice(launch.mint);
  } catch {
    /* ignore */
  }

  // Holder check
  let holderCount: number | null = null;
  try {
    const holders = await fetchTokenHolders(launch.mint);
    holderCount = holders.count;

    const milestoneAlerts = [100, 500, 1000, 5000, 10000];
    for (const milestone of milestoneAlerts) {
      const prevAlert = entry.alerts.find(
        (a) => a.type === `holders_${milestone}`
      );
      if (holders.count >= milestone && !prevAlert) {
        const alert = {
          type: `holders_${milestone}`,
          message: `$${launch.symbol}: Reached ${milestone} holders!`,
          timestamp: Date.now(),
          severity: "info" as const,
        };
        performanceAlerts.push(alert);
        entry.alerts.push(alert);
      }
    }
  } catch (err) {
    console.error(`[Guardian] Holder check error for $${launch.symbol}:`, err);
  }

  // Price alerts
  if (currentPrice && entry.initial_price) {
    const priceChange = ((currentPrice - entry.initial_price) / entry.initial_price) * 100;
    if (priceChange <= -20) {
      const alert = {
        type: "price_drop",
        message: `$${launch.symbol}: Price dropped ${priceChange.toFixed(1)}%`,
        timestamp: Date.now(),
        severity: "warning" as const,
      };
      alerts.push(alert);
      entry.alerts.push(alert);
    }
    if (priceChange >= 20) {
      const alert = {
        type: "price_surge",
        message: `$${launch.symbol}: Price surged +${priceChange.toFixed(1)}%`,
        timestamp: Date.now(),
        severity: "info" as const,
      };
      performanceAlerts.push(alert);
      entry.alerts.push(alert);
    }
  }

  // LP exit conditions (from liquidity.ts)
  let lpAction = { should_exit: false, reason: "" as string | undefined, exit_type: undefined as string | undefined, pnl_pct: 0 };
  if (currentPrice) {
    const position = getPosition(launch.mint);
    if (position) {
      const exitCheck = checkLpExitConditions(launch.mint, currentPrice);
      if (exitCheck.should_exit) {
        lpAction = {
          should_exit: true,
          reason: exitCheck.reason,
          exit_type: exitCheck.exit_type,
          pnl_pct: exitCheck.pnl_pct,
        };

        const alertType = exitCheck.exit_type || "exit";
        const alertSeverity = exitCheck.exit_type === "emergency" ? "critical" : "warning";
        const alert = {
          type: alertType,
          message: `$${launch.symbol}: ${exitCheck.reason}`,
          timestamp: Date.now(),
          severity: alertSeverity as "info" | "warning" | "critical",
        };
        alerts.push(alert);
        entry.alerts.push(alert);
      } else {
        // Update highest price in position
        if (currentPrice > position.highest_price) {
          position.highest_price = currentPrice;
        }
      }
    }
  }

  // Snapshot
  const snapshot = {
    price: currentPrice,
    holders: holderCount,
    timestamp: Date.now(),
  };
  entry.last_snapshot = snapshot;

  // Trim alerts
  if (entry.alerts.length > 100) {
    entry.alerts = entry.alerts.slice(-50);
  }
  saveState();

  return {
    alerts,
    performanceAlerts,
    lpAction: {
      should_exit: lpAction.should_exit,
      reason: lpAction.reason || "",
      exit_type: lpAction.exit_type,
      pnl_pct: lpAction.pnl_pct,
    },
    snapshot,
  };
}

export function getAllActiveGuardians(): GuardianEntry[] {
  return Array.from(guardians.values()).filter((g) => g.active);
}

export function getGuardianStatus(mint: string): GuardianEntry | null {
  loadState();
  return guardians.get(mint) || null;
}

export function deactivateGuardian(mint: string): boolean {
  const entry = guardians.get(mint);
  if (!entry) return false;
  entry.active = false;
  saveState();
  console.log(`[Guardian] Deactivated: $${entry.symbol}`);
  return true;
}
