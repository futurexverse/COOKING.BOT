import { Connection, Transaction, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { getSolanaKeypair, getConnection } from "./solana-wallet.js";

const JUPITER_BASE = "https://api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1000000000;

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: unknown[];
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  error?: string;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 50
): Promise<JupiterQuote | null> {
  try {
    const url = `${JUPITER_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    return await resp.json() as JupiterQuote;
  } catch {
    return null;
  }
}

export async function executeJupiterSwap(
  quote: JupiterQuote
): Promise<SwapResult> {
  try {
    const keypair = getSolanaKeypair();
    const connection = getConnection();

    const swapResp = await fetch(`${JUPITER_BASE}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!swapResp.ok) {
      const err = await swapResp.text();
      return { success: false, error: `Jupiter swap API error: ${err}` };
    }

    const swapData = await swapResp.json() as { swapTransaction: string };
    if (!swapData.swapTransaction) {
      return { success: false, error: "No swap transaction returned" };
    }

    const txBuf = Buffer.from(swapData.swapTransaction, "base64");
    const tx = Transaction.from(txBuf);
    tx.sign(keypair as any);

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    await connection.confirmTransaction(txHash, "confirmed");

    return {
      success: true,
      txHash,
      amountIn: quote.inAmount,
      amountOut: quote.outAmount,
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function buyTokenSolana(
  tokenMint: string,
  solAmount: number,
  slippageBps: number = 50
): Promise<SwapResult> {
  const amountLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const quote = await getJupiterQuote(SOL_MINT, tokenMint, amountLamports, slippageBps);
  if (!quote) return { success: false, error: "Failed to get Jupiter quote" };
  return executeJupiterSwap(quote);
}

export async function sellTokenSolana(
  tokenMint: string,
  percentage: number = 100,
  slippageBps: number = 50
): Promise<SwapResult> {
  try {
    const { getAssociatedTokenAddress, getAccount } = await import("@solana/spl-token");
    const connection = getConnection();
    const keypair = getSolanaKeypair();
    const tokenPub = new PublicKey(tokenMint);
    const ata = await getAssociatedTokenAddress(tokenPub, keypair.publicKey);
    const account = await getAccount(connection, ata);

    const totalAmount = Number(account.amount);
    const sellAmount = Math.floor(totalAmount * (percentage / 100));
    if (sellAmount <= 0) return { success: false, error: "No tokens to sell" };

    const quote = await getJupiterQuote(tokenMint, SOL_MINT, sellAmount, slippageBps);
    if (!quote) return { success: false, error: "Failed to get Jupiter quote" };
    return executeJupiterSwap(quote);
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function getTokenBalanceSolana(tokenMint: string): Promise<string> {
  try {
    const { getAssociatedTokenAddress, getAccount } = await import("@solana/spl-token");
    const connection = getConnection();
    const keypair = getSolanaKeypair();
    const tokenPub = new PublicKey(tokenMint);
    const ata = await getAssociatedTokenAddress(tokenPub, keypair.publicKey);
    const account = await getAccount(connection, ata);
    return account.amount.toString();
  } catch {
    return "0";
  }
}
