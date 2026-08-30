import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

export interface LpPosition {
  mint: string;
  symbol: string;
  entry_price: number;
  entry_amount: number;
  entry_timestamp: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  trailing_stop_enabled: boolean;
  trailing_stop_pct: number;
  highest_price: number;
}

export interface LpAction {
  type: "stop_loss" | "take_profit" | "trailing_stop" | "manual";
  mint: string;
  price: number;
  pnl_pct: number;
  timestamp: number;
  tx_signature?: string;
}

function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

function getKeypair(): Keypair {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) throw new Error("SOLANA_PRIVATE_KEY required");
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

const positions = new Map<string, LpPosition>();

export function registerPosition(
  mint: string,
  symbol: string,
  entryPrice: number,
  entryAmount: number
): void {
  const stopLossPct = parseFloat(process.env.GUARDIAN_STOP_LOSS_PCT || "-30");
  const takeProfitPct = parseFloat(process.env.GUARDIAN_TAKE_PROFIT_PCT || "100");
  const trailingEnabled = process.env.GUARDIAN_TRAILING_STOP_ENABLED === "true";
  const trailingPct = parseFloat(process.env.GUARDIAN_TRAILING_STOP_PCT || "15");

  positions.set(mint, {
    mint,
    symbol,
    entry_price: entryPrice,
    entry_amount: entryAmount,
    entry_timestamp: Date.now(),
    stop_loss_pct: stopLossPct,
    take_profit_pct: takeProfitPct,
    trailing_stop_enabled: trailingEnabled,
    trailing_stop_pct: trailingPct,
    highest_price: entryPrice,
  });
}

export function checkLpExitConditions(
  mint: string,
  currentPrice: number
): { should_exit: boolean; reason?: string; pnl_pct: number } {
  const position = positions.get(mint);
  if (!position) {
    return { should_exit: false, pnl_pct: 0 };
  }

  const pnlPct =
    ((currentPrice - position.entry_price) / position.entry_price) * 100;

  if (currentPrice > position.highest_price) {
    position.highest_price = currentPrice;
  }

  if (pnlPct <= position.stop_loss_pct) {
    return {
      should_exit: true,
      reason: `Stop loss triggered: ${pnlPct.toFixed(1)}% (threshold: ${position.stop_loss_pct}%)`,
      pnl_pct: pnlPct,
    };
  }

  if (pnlPct >= position.take_profit_pct) {
    return {
      should_exit: true,
      reason: `Take profit triggered: ${pnlPct.toFixed(1)}% (threshold: ${position.take_profit_pct}%)`,
      pnl_pct: pnlPct,
    };
  }

  if (
    position.trailing_stop_enabled &&
    position.highest_price > position.entry_price
  ) {
    const trailingThreshold =
      position.highest_price * (1 - position.trailing_stop_pct / 100);
    if (currentPrice <= trailingThreshold) {
      const peakPnl =
        ((position.highest_price - position.entry_price) /
          position.entry_price) *
        100;
      return {
        should_exit: true,
        reason: `Trailing stop triggered: peaked at +${peakPnl.toFixed(1)}%, now at +${pnlPct.toFixed(1)}%`,
        pnl_pct: pnlPct,
      };
    }
  }

  return { should_exit: false, pnl_pct: pnlPct };
}

export async function executeSell(
  mint: string
): Promise<LpAction | null> {
  const position = positions.get(mint);
  if (!position) return null;

  const connection = getConnection();
  const wallet = getKeypair();

  try {
    const tokenAta = await getAssociatedTokenAddress(
      new PublicKey(mint),
      wallet.publicKey
    );

    const balance = await connection.getTokenAccountBalance(tokenAta);
    if (balance.value.amount === "0") {
      positions.delete(mint);
      return null;
    }

    const closeIx = createCloseAccountInstruction(
      tokenAta,
      wallet.publicKey,
      wallet.publicKey,
      [],
      TOKEN_PROGRAM_ID
    );

    const tx = new Transaction().add(closeIx);
    const signature = await connection.sendTransaction(tx, [wallet]);

    const currentPrice = position.entry_price * (1 + (parseFloat(balance.value.amount) / position.entry_amount - 1));
    const pnlPct =
      ((currentPrice - position.entry_price) / position.entry_price) * 100;

    positions.delete(mint);

    return {
      type: "stop_loss",
      mint,
      price: currentPrice,
      pnl_pct: pnlPct,
      timestamp: Date.now(),
      tx_signature: signature,
    };
  } catch (err) {
    console.error(`[Liquidity] Sell failed for ${mint}:`, err);
    return null;
  }
}

export function getPosition(mint: string): LpPosition | undefined {
  return positions.get(mint);
}

export function getAllPositions(): LpPosition[] {
  return Array.from(positions.values());
}
