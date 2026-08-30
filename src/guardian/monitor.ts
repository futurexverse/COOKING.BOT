import type { GuardianStatus, LaunchRecord } from "../schemas/index.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { detectRugSignals, type RugAlert } from "./rug-detect.js";
import {
  getPerformanceSnapshot,
  checkPerformanceAlerts,
  type PerformanceSnapshot,
} from "./performance.js";
import { checkLpExitConditions, executeSell, registerPosition } from "./liquidity.js";
import { dispatchAlert } from "./alerts.js";

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
  last_snapshot: PerformanceSnapshot | null;
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

function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

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

  if (initialPrice) {
    registerPosition(mint, symbol, initialPrice, 0);
  }

  console.log(`[Guardian] Registered: $${symbol} (${mint.slice(0, 8)}...)`);
}

export async function runGuardianCycle(
  launch: LaunchRecord
): Promise<{
  alerts: RugAlert[];
  performanceAlerts: ReturnType<typeof checkPerformanceAlerts>;
  lpAction: ReturnType<typeof checkLpExitConditions>;
  snapshot: PerformanceSnapshot;
}> {
  const entry = guardians.get(launch.mint);
  if (!entry || !entry.active) {
    return {
      alerts: [],
      performanceAlerts: [],
      lpAction: { should_exit: false, pnl_pct: 0 },
      snapshot: {
        mint: launch.mint,
        symbol: launch.symbol,
        timestamp: Date.now(),
        price: null,
        price_change_1h: null,
        price_change_24h: null,
        volume_24h: null,
        holders: null,
        liquidity: null,
        market_cap: null,
        pnl_from_launch: null,
      },
    };
  }

  console.log(`[Guardian] Running cycle for $${launch.symbol}...`);

  const rugAlerts = await detectRugSignals(launch.mint);
  for (const alert of rugAlerts) {
    entry.alerts.push(alert);
    await dispatchAlert(alert, launch.symbol, launch.mint);
  }

  const snapshot = await getPerformanceSnapshot(
    launch.mint,
    launch.symbol,
    entry.initial_price
  );

  const perfAlerts = checkPerformanceAlerts(
    snapshot,
    entry.last_snapshot || undefined
  );
  for (const alert of perfAlerts) {
    entry.alerts.push(alert);
    await dispatchAlert(
      {
        type: alert.type,
        message: alert.message,
        timestamp: alert.timestamp,
        severity: alert.severity,
      },
      launch.symbol,
      launch.mint
    );
  }

  let lpAction: { should_exit: boolean; reason?: string; pnl_pct: number } = { should_exit: false, pnl_pct: 0 };
  if (snapshot.price) {
    lpAction = checkLpExitConditions(launch.mint, snapshot.price);

    if (lpAction.should_exit) {
      console.log(
        `[Guardian] LP EXIT: $${launch.symbol} — ${lpAction.reason}`
      );
      const sellResult = await executeSell(launch.mint);
      if (sellResult) {
        await dispatchAlert(
          {
            type: "lp_exit",
            message: `Auto-sell executed: ${lpAction.reason} | PnL: ${lpAction.pnl_pct.toFixed(1)}% | TX: ${sellResult.tx_signature}`,
            timestamp: Date.now(),
            severity: lpAction.pnl_pct < -20 ? "critical" : "warning",
          },
          launch.symbol,
          launch.mint
        );
      }
    }
  }

  entry.last_snapshot = snapshot;
  if (entry.alerts.length > 100) {
    entry.alerts = entry.alerts.slice(-50);
  }
  saveState();

  return { alerts: rugAlerts, performanceAlerts: perfAlerts, lpAction, snapshot };
}

export async function getGuardianStatus(
  mint: string
): Promise<GuardianStatus | null> {
  loadState();
  const entry = guardians.get(mint);
  if (!entry) return null;

  const snapshot = entry.last_snapshot;

  return {
    mint: entry.mint,
    symbol: entry.symbol,
    active: entry.active,
    uptime_seconds: Math.floor((Date.now() - entry.launched_at) / 1000),
    current_price: snapshot?.price || undefined,
    price_change_pct: snapshot?.price_change_24h || undefined,
    volume_24h: snapshot?.volume_24h || undefined,
    holders: snapshot?.holders || undefined,
    liquidity: snapshot?.liquidity || undefined,
    pnl_pct: snapshot?.pnl_from_launch || undefined,
    alerts: entry.alerts.slice(-10),
    last_check: snapshot?.timestamp || entry.launched_at,
  };
}

export function getAllActiveGuardians(): GuardianEntry[] {
  loadState();
  return Array.from(guardians.values()).filter((g) => g.active);
}

export function deactivateGuardian(mint: string): boolean {
  const entry = guardians.get(mint);
  if (!entry) return false;
  entry.active = false;
  saveState();
  console.log(`[Guardian] Deactivated: $${entry.symbol}`);
  return true;
}
