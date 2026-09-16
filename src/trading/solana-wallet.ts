import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const SOLANA_WALLET_FILE = join(ROOT_DIR, "data", "solana-wallet.json");

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

let cachedKeypair: Keypair | null = null;
let cachedConnection: Connection | null = null;

export function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(SOLANA_RPC, "confirmed");
  }
  return cachedConnection;
}

function loadKeypairFromFile(): Keypair | null {
  try {
    if (existsSync(SOLANA_WALLET_FILE)) {
      const data = JSON.parse(readFileSync(SOLANA_WALLET_FILE, "utf-8"));
      if (data.secretKey) {
        const secretKey = Uint8Array.from(data.secretKey);
        const keypair = Keypair.fromSecretKey(secretKey);
        console.log(`[SolanaWallet] Loaded existing wallet: ${keypair.publicKey.toBase58()}`);
        return keypair;
      }
    }
  } catch (err) {
    console.error("[SolanaWallet] Failed to load from file:", err);
  }
  return null;
}

function saveKeypairToFile(keypair: Keypair): void {
  const dir = dirname(SOLANA_WALLET_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
    createdAt: Date.now(),
  };
  writeFileSync(SOLANA_WALLET_FILE, JSON.stringify(data, null, 2));
  console.log(`[SolanaWallet] Saved wallet to ${SOLANA_WALLET_FILE}`);
}

export function getSolanaKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  const envKey = process.env.SOLANA_PRIVATE_KEY;
  if (envKey) {
    let secretKeyBytes: Uint8Array;
    try {
      const decoded = JSON.parse(envKey);
      secretKeyBytes = Uint8Array.from(decoded);
    } catch {
      secretKeyBytes = Buffer.from(envKey, "base64");
    }
    cachedKeypair = Keypair.fromSecretKey(secretKeyBytes);
    console.log(`[SolanaWallet] Loaded from env var: ${cachedKeypair.publicKey.toBase58()}`);
    saveKeypairToFile(cachedKeypair);
    return cachedKeypair;
  }

  const evmKey = process.env.WALLET_PRIVATE_KEY;
  if (evmKey) {
    const privateKeyBytes = Buffer.from(evmKey.replace("0x", ""), "hex");
    cachedKeypair = Keypair.fromSecretKey(privateKeyBytes);
    console.log(`[SolanaWallet] Derived from EVM key: ${cachedKeypair.publicKey.toBase58()}`);
    saveKeypairToFile(cachedKeypair);
    return cachedKeypair;
  }

  const fileKeypair = loadKeypairFromFile();
  if (fileKeypair) {
    cachedKeypair = fileKeypair;
    return cachedKeypair;
  }

  console.log("[SolanaWallet] Generating new wallet...");
  const newKeypair = Keypair.generate();
  cachedKeypair = newKeypair;
  saveKeypairToFile(newKeypair);
  console.log(`[SolanaWallet] Generated new wallet: ${newKeypair.publicKey.toBase58()}`);
  return cachedKeypair;
}

export async function getSolBalance(): Promise<{ sol: string; lamports: bigint }> {
  const connection = getConnection();
  const pubkey = getSolanaKeypair().publicKey;
  const balance = await connection.getBalance(pubkey);
  return {
    sol: (balance / LAMPORTS_PER_SOL).toFixed(6),
    lamports: BigInt(balance),
  };
}

export function getSolanaAddress(): string {
  return getSolanaKeypair().publicKey.toBase58();
}

export async function hasEnoughSOL(minSol: number): Promise<boolean> {
  const { lamports } = await getSolBalance();
  return lamports >= BigInt(Math.floor(minSol * LAMPORTS_PER_SOL));
}
