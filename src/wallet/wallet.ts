import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..", "..");
const WALLET_FILE = join(ROOT_DIR, "data", "wallet.json");

const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;

let cachedWallet: ethers.Wallet | null = null;
let cachedProvider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new ethers.JsonRpcProvider(ROBINHOOD_RPC, CHAIN_ID);
  }
  return cachedProvider;
}

function ensureDataDir(): void {
  const dir = dirname(WALLET_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadWalletFromFile(): ethers.Wallet | null {
  try {
    if (existsSync(WALLET_FILE)) {
      const data = JSON.parse(readFileSync(WALLET_FILE, "utf-8"));
      if (data.privateKey) {
        const wallet = new ethers.Wallet(data.privateKey, getProvider());
        console.log(`[Wallet] Loaded existing wallet: ${wallet.address}`);
        return wallet;
      }
    }
  } catch (err) {
    console.error("[Wallet] Failed to load wallet from file:", err);
  }
  return null;
}

function saveWalletToFile(wallet: ethers.Wallet): void {
  ensureDataDir();
  const data = {
    address: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: Date.now(),
  };
  writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
  console.log(`[Wallet] Saved wallet to ${WALLET_FILE}`);
}

export function getWallet(): ethers.Wallet {
  if (cachedWallet) return cachedWallet;

  const envKey = process.env.WALLET_PRIVATE_KEY;
  if (envKey) {
    cachedWallet = new ethers.Wallet(envKey, getProvider());
    console.log(`[Wallet] Loaded from env var: ${cachedWallet.address}`);
    saveWalletToFile(cachedWallet);
    return cachedWallet;
  }

  const fileWallet = loadWalletFromFile();
  if (fileWallet) {
    cachedWallet = fileWallet;
    return cachedWallet;
  }

  console.log("[Wallet] No wallet found — generating new one...");
  const randomWallet = ethers.Wallet.createRandom();
  const newWallet = new ethers.Wallet(randomWallet.privateKey, getProvider());
  cachedWallet = newWallet;
  saveWalletToFile(newWallet);
  console.log(`[Wallet] Generated new wallet: ${newWallet.address}`);
  return newWallet;
}

export async function getBalance(): Promise<{ eth: string; wei: bigint }> {
  const wallet = getProvider();
  const addr = getWallet().address;
  const balance = await wallet.getBalance(addr);
  return {
    eth: ethers.formatEther(balance),
    wei: balance,
  };
}

export async function hasEnoughBalance(minEth: number): Promise<boolean> {
  const { wei } = await getBalance();
  return wei >= ethers.parseEther(minEth.toString());
}

export function getWalletAddress(): string {
  return getWallet().address;
}

export async function getGasPrice(): Promise<bigint> {
  const provider = getProvider();
  const feeData = await provider.getFeeData();
  return feeData.gasPrice || ethers.parseUnits("1", "gwei");
}
