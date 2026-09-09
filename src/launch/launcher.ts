import type { LaunchProposal, LaunchRecord, TradeRecord } from "../schemas/index.js";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { launchTokenViaNofxa } from "../market/sources/noxa.js";

const DATA_DIR = process.env.ORACLE_DATA_DIR || "data";
const LAUNCHES_FILE = join(DATA_DIR, "launches.json");
const TRADES_FILE = join(DATA_DIR, "trades.json");

const activeLaunches: LaunchRecord[] = [];
const tradeHistory: TradeRecord[] = [];

function loadLaunches(): void {
  if (existsSync(LAUNCHES_FILE)) {
    try {
      const data = JSON.parse(readFileSync(LAUNCHES_FILE, "utf-8"));
      activeLaunches.push(...data);
    } catch {
      /* ignore corrupt file */
    }
  }
}

function saveLaunches(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(LAUNCHES_FILE, JSON.stringify(activeLaunches, null, 2));
}

function loadTrades(): void {
  if (existsSync(TRADES_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TRADES_FILE, "utf-8"));
      tradeHistory.push(...data);
    } catch {}
  }
}

function saveTrades(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(TRADES_FILE, JSON.stringify(tradeHistory.slice(-200), null, 2));
}

export function addTrade(record: TradeRecord): void {
  tradeHistory.push(record);
  saveTrades();
}

export function getTradeHistory(): TradeRecord[] {
  return tradeHistory.slice(-50);
}

loadLaunches();
loadTrades();

const AUTO_BUY_ETH = parseFloat(process.env.AUTO_BUY_ETH || "0.005");

async function launchViaNofxa(
  proposal: LaunchProposal
): Promise<LaunchRecord> {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) {
    throw new Error("WALLET_PRIVATE_KEY is required for token launches on Robinhood Chain");
  }

  const result = await launchTokenViaNofxa({
    name: proposal.name,
    symbol: proposal.symbol,
    description: `Launched by COOKING on Robinhood Chain`,
    image: "",
    website: "",
    twitter: "",
    telegram: "",
  });

  if (!result || !result.success || !result.token_address) {
    throw new Error(`Launch failed: ${result?.error || "unknown error"}`);
  }

  const record: LaunchRecord = {
    decision_id: proposal.decision_id,
    symbol: proposal.symbol,
    name: proposal.name,
    mint: result.token_address,
    platform: "pons",
    tx_signature: result.tx_hash || "",
    cost_eth: proposal.estimated_cost_eth,
    launched_at: Date.now(),
    guardian_active: true,
    initial_price: 0,
    initial_liquidity: 0,
  };

  activeLaunches.push(record);
  saveLaunches();

  if (AUTO_BUY_ETH > 0) {
    try {
      const { buyToken } = await import("../trading/buy.js");
      console.log(`[Launcher] Auto-buying ${proposal.symbol} with ${AUTO_BUY_ETH} ETH...`);
      const buyResult = await buyToken(result.token_address, AUTO_BUY_ETH.toString());
      if (buyResult.success) {
        console.log(`[Launcher] Auto-buy successful: ${buyResult.txHash}`);
        addTrade({
          txHash: buyResult.txHash || "",
          type: "buy",
          tokenAddress: result.token_address,
          tokenSymbol: proposal.symbol,
          amountIn: AUTO_BUY_ETH.toString(),
          amountOut: buyResult.amountOut || "0",
          ethSpent: AUTO_BUY_ETH.toString(),
          timestamp: Date.now(),
          status: "success",
        });
      } else {
        console.error(`[Launcher] Auto-buy failed: ${buyResult.error}`);
        addTrade({
          txHash: "",
          type: "buy",
          tokenAddress: result.token_address,
          tokenSymbol: proposal.symbol,
          amountIn: AUTO_BUY_ETH.toString(),
          amountOut: "0",
          ethSpent: AUTO_BUY_ETH.toString(),
          timestamp: Date.now(),
          status: "failed",
          error: buyResult.error,
        });
      }
    } catch (err) {
      console.error(`[Launcher] Auto-buy error:`, err);
    }
  }

  return record;
}

export async function executeLaunch(
  proposal: LaunchProposal
): Promise<LaunchRecord> {
  if (proposal.status !== "approved") {
    throw new Error(
      `Cannot launch: proposal status is "${proposal.status}", must be "approved"`
    );
  }

  return launchViaNofxa(proposal);
}

export function getActiveLaunches(): LaunchRecord[] {
  return activeLaunches.filter((l) => l.guardian_active);
}

export function getAllLaunches(): LaunchRecord[] {
  return activeLaunches;
}

export function getLaunchByMint(mint: string): LaunchRecord | undefined {
  return activeLaunches.find((l) => l.mint === mint);
}
