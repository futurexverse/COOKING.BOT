import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { launchTokenViaNofxa } from "../market/sources/noxa.js";
import { sendProposalToTelegram } from "../social/telegram-bot.js";
import { registerProposal } from "../social/approval.js";
import type { LaunchProposal, LaunchRecord } from "../schemas/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const LAUNCHES_FILE = join(ROOT_DIR, "data", "launches.json");

interface LaunchStore {
  launches: LaunchRecord[];
}

let store: LaunchStore = { launches: [] };

function loadLaunches(): void {
  if (existsSync(LAUNCHES_FILE)) {
    try {
      store = JSON.parse(readFileSync(LAUNCHES_FILE, "utf-8"));
    } catch {
      store = { launches: [] };
    }
  }
}

function saveLaunches(): void {
  const dir = dirname(LAUNCHES_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LAUNCHES_FILE, JSON.stringify(store, null, 2));
}

loadLaunches();

function getPrivateKey(): string {
  return process.env.WALLET_PRIVATE_KEY || "";
}

function getRpcUrl(): string {
  return process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
}

export function getActiveLaunches(): LaunchRecord[] {
  return store.launches.filter((l) => l.guardian_active);
}

export function getAllLaunches(): LaunchRecord[] {
  return store.launches;
}

export async function executeEvmLaunch(
  proposal: LaunchProposal
): Promise<LaunchRecord | null> {
  const pk = getPrivateKey();
  if (!pk) {
    console.error("[Launcher] No WALLET_PRIVATE_KEY set");
    return null;
  }

  console.log(
    `[Launcher] Executing launch for $${proposal.symbol} on Robinhood Chain...`
  );

  try {
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
      console.error("[Launcher] Launch failed:", result?.error);
      return null;
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

    store.launches.push(record);
    saveLaunches();

    console.log(
      `[Launcher] $${proposal.symbol} launched! Token: ${result.token_address}`
    );

    return record;
  } catch (err) {
    console.error("[Launcher] Launch error:", err);
    return null;
  }
}

export function deactivateGuardian(decisionId: string): void {
  const launch = store.launches.find(
    (l) => l.decision_id === decisionId
  );
  if (launch) {
    launch.guardian_active = false;
    saveLaunches();
  }
}
