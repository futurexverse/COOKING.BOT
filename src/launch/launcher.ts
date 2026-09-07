import type { LaunchProposal, LaunchRecord } from "../schemas/index.js";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { launchTokenViaNofxa } from "../market/sources/noxa.js";

const DATA_DIR = process.env.ORACLE_DATA_DIR || "data";
const LAUNCHES_FILE = join(DATA_DIR, "launches.json");

const activeLaunches: LaunchRecord[] = [];

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

loadLaunches();

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
    platform: "noxafun",
    tx_signature: result.tx_hash || "",
    cost_eth: proposal.estimated_cost_eth,
    launched_at: Date.now(),
    guardian_active: true,
    initial_price: 0,
    initial_liquidity: 0,
  };

  activeLaunches.push(record);
  saveLaunches();

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
