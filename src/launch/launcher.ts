import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
} from "@solana/spl-token";
import bs58 from "bs58";
import type { LaunchProposal, LaunchRecord } from "../schemas/index.js";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

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

function getConnection(): Connection {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

function getKeypair(): Keypair {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("SOLANA_PRIVATE_KEY is required for token launches");
  }
  const decoded = bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

async function launchOnPumpfun(
  proposal: LaunchProposal
): Promise<LaunchRecord> {
  const connection = getConnection();
  const wallet = getKeypair();

  const balance = await connection.getBalance(wallet.publicKey);
  const minBalance = parseFloat(
    process.env.LAUNCH_MAX_COST_SOL || "5"
  ) * 1e9;
  if (balance < minBalance + 0.01e9) {
    throw new Error(
      `Insufficient SOL balance: ${balance / 1e9} SOL (need ${(minBalance + 0.01e9) / 1e9})`
    );
  }

  const mintKeypair = Keypair.generate();

  const lamports = await connection.getMinimumBalanceForRentExemption(
    MINT_SIZE
  );

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: wallet.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID,
  });

  const initMintIx = createInitializeMintInstruction(
    mintKeypair.publicKey,
    9,
    wallet.publicKey,
    wallet.publicKey,
    TOKEN_PROGRAM_ID
  );

  const ata = await getAssociatedTokenAddress(
    mintKeypair.publicKey,
    wallet.publicKey
  );

  const createAtaIx = await createAssociatedTokenAccountInstruction(
    wallet.publicKey,
    ata,
    wallet.publicKey,
    mintKeypair.publicKey
  );

  const tx = new Transaction().add(
    createAccountIx,
    initMintIx,
    createAtaIx
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [
    wallet,
    mintKeypair,
  ]);

  const record: LaunchRecord = {
    decision_id: proposal.decision_id,
    symbol: proposal.symbol,
    name: proposal.name,
    mint: mintKeypair.publicKey.toBase58(),
    platform: "pumpfun",
    tx_signature: signature,
    cost_sol: (lamports + 5000) / 1e9,
    launched_at: Date.now(),
    guardian_active: true,
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

  const platform =
    process.env.LAUNCH_PLATFORM || proposal.platform || "auto";

  switch (platform) {
    case "pumpfun":
      return launchOnPumpfun(proposal);
    case "raydium":
      throw new Error("Raydium launch not yet implemented");
    case "auto":
    default:
      return launchOnPumpfun(proposal);
  }
}

export function getActiveLaunches(): LaunchRecord[] {
  loadLaunches();
  return activeLaunches;
}

export function getLaunchByMint(mint: string): LaunchRecord | undefined {
  return activeLaunches.find((l) => l.mint === mint);
}
