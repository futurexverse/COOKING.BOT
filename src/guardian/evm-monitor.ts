import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getTokenPrice } from "../market/sources/uniswap.js";
import { checkTokenSafety, fetchTokenHolders } from "../market/sources/blockscout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const GUARDIAN_STATE_FILE = join(ROOT_DIR, "data", "guardian_state.json");

interface GuardianEntry {
  mint: string;
  symbol: string;
  active: boolean;
  started_at: number;
  last_check: number;
  initial_price: number;
  initial_liquidity: number;
  alerts: Array<{
    type: string;
    message: string;
    timestamp: number;
    severity: "info" | "warning" | "critical";
  }>;
}

interface GuardianState {
  guardians: GuardianEntry[];
}

let state: GuardianState = { guardians: [] };

function loadState(): void {
  if (existsSync(GUARDIAN_STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(GUARDIAN_STATE_FILE, "utf-8"));
    } catch {
      state = { guardians: [] };
    }
  }
}

function saveState(): void {
  const dir = dirname(GUARDIAN_STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GUARDIAN_STATE_FILE, JSON.stringify(state, null, 2));
}

loadState();

export function registerGuardian(mint: string, symbol: string, initialPrice: number): void {
  const existing = state.guardians.find((g) => g.mint === mint);
  if (existing) {
    existing.active = true;
    existing.last_check = Date.now();
  } else {
    state.guardians.push({
      mint,
      symbol,
      active: true,
      started_at: Date.now(),
      last_check: Date.now(),
      initial_price: initialPrice,
      initial_liquidity: 0,
      alerts: [],
    });
  }
  saveState();
  console.log(`[Guardian] Registered $${symbol} (${mint})`);
}

export function getAllActiveGuardians(): GuardianEntry[] {
  return state.guardians.filter((g) => g.active);
}

export interface GuardianResult {
  alerts: Array<{
    type: string;
    message: string;
    severity: "info" | "warning" | "critical";
  }>;
  performanceAlerts: Array<{
    type: string;
    message: string;
    severity: "info" | "warning" | "critical";
  }>;
  lpAction: {
    should_exit: boolean;
    reason: string;
  };
}

export async function runGuardianCycle(
  launch: { mint: string; symbol: string }
): Promise<GuardianResult> {
  const result: GuardianResult = {
    alerts: [],
    performanceAlerts: [],
    lpAction: { should_exit: false, reason: "" },
  };

  const guardian = state.guardians.find(
    (g) => g.mint === launch.mint && g.active
  );
  if (!guardian) return result;

  const now = Date.now();
  guardian.last_check = now;

  try {
    const safety = await checkTokenSafety(launch.mint);
    if (safety) {
      if (safety.owner_renounced === false && safety.has_mint_authority) {
        result.alerts.push({
          type: "rug_mint",
          message: `$${launch.symbol}: Owner has mint authority - possible rug`,
          severity: "critical",
        });
      }

      if (safety.top_holder_pct > 30) {
        result.alerts.push({
          type: "concentration",
          message: `$${launch.symbol}: Top holder owns ${safety.top_holder_pct.toFixed(1)}%`,
          severity: "warning",
        });
      }
    }
  } catch (err) {
    console.error(`[Guardian] Safety check error for $${launch.symbol}:`, err);
  }

  try {
    const holders = await fetchTokenHolders(launch.mint);
    if (holders.count > 0) {
      const milestoneAlerts = [100, 500, 1000, 5000, 10000];
      for (const milestone of milestoneAlerts) {
        const prevAlert = guardian.alerts.find(
          (a) => a.type === `holders_${milestone}`
        );
        if (holders.count >= milestone && !prevAlert) {
          result.performanceAlerts.push({
            type: `holders_${milestone}`,
            message: `$${launch.symbol}: Reached ${milestone} holders!`,
            severity: "info",
          });
          guardian.alerts.push({
            type: `holders_${milestone}`,
            message: `Reached ${milestone} holders`,
            timestamp: now,
            severity: "info",
          });
        }
      }
    }
  } catch (err) {
    console.error(`[Guardian] Holder check error for $${launch.symbol}:`, err);
  }

  saveState();
  return result;
}

export function deactivateGuardian(mint: string): void {
  const guardian = state.guardians.find((g) => g.mint === mint);
  if (guardian) {
    guardian.active = false;
    saveState();
  }
}
