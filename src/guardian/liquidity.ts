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
  type: "stop_loss" | "take_profit" | "trailing_stop" | "manual" | "emergency";
  mint: string;
  price: number;
  pnl_pct: number;
  timestamp: number;
  tx_hash?: string;
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

  console.log(`[Liquidity] Registered position: $${symbol} at ${entryPrice} ETH`);
}

export function checkLpExitConditions(
  mint: string,
  currentPrice: number
): { should_exit: boolean; reason?: string; pnl_pct: number; exit_type?: string } {
  const position = positions.get(mint);
  if (!position) {
    return { should_exit: false, pnl_pct: 0 };
  }

  const pnlPct =
    ((currentPrice - position.entry_price) / position.entry_price) * 100;

  if (currentPrice > position.highest_price) {
    position.highest_price = currentPrice;
  }

  // Emergency exit: >50% drop - auto-sell without confirmation
  if (pnlPct <= -50) {
    return {
      should_exit: true,
      reason: `EMERGENCY: Price dropped ${pnlPct.toFixed(1)}% — auto-selling`,
      pnl_pct: pnlPct,
      exit_type: "emergency",
    };
  }

  // Stop loss: requires confirmation
  if (pnlPct <= position.stop_loss_pct) {
    return {
      should_exit: true,
      reason: `Stop loss triggered: ${pnlPct.toFixed(1)}% (threshold: ${position.stop_loss_pct}%)`,
      pnl_pct: pnlPct,
      exit_type: "stop_loss",
    };
  }

  // Take profit: requires confirmation
  if (pnlPct >= position.take_profit_pct) {
    return {
      should_exit: true,
      reason: `Take profit triggered: ${pnlPct.toFixed(1)}% (threshold: ${position.take_profit_pct}%)`,
      pnl_pct: pnlPct,
      exit_type: "take_profit",
    };
  }

  // Trailing stop: requires confirmation
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
        exit_type: "trailing_stop",
      };
    }
  }

  return { should_exit: false, pnl_pct: pnlPct };
}

export async function executeSell(
  mint: string,
  exitType: string = "manual"
): Promise<LpAction | null> {
  const position = positions.get(mint);
  if (!position) return null;

  try {
    const { sellToken } = await import("../trading/sell.js");
    const { addTrade } = await import("../launch/launcher.js");

    console.log(`[Liquidity] Executing sell for ${mint} (type: ${exitType})...`);
    const result = await sellToken(mint, 100);

    if (result.success) {
      addTrade({
        txHash: result.txHash || "",
        type: "sell",
        tokenAddress: mint,
        tokenSymbol: position.symbol,
        amountIn: result.amountIn || "0",
        amountOut: result.amountOut || "0",
        ethReceived: result.amountOut || "0",
        timestamp: Date.now(),
        status: "success",
      });

      const pnlPct =
        ((0 - position.entry_price) / position.entry_price) * 100;

      positions.delete(mint);
      console.log(`[Liquidity] Sell successful for ${mint}: ${result.amountOut} ETH`);

      return {
        type: exitType as LpAction["type"],
        mint,
        price: position.entry_price,
        pnl_pct: pnlPct,
        timestamp: Date.now(),
        tx_hash: result.txHash,
      };
    } else {
      console.error(`[Liquidity] Sell failed: ${result.error}`);
      return null;
    }
  } catch (err) {
    console.error(`[Liquidity] Sell error:`, err);
    return null;
  }
}

export function getPosition(mint: string): LpPosition | undefined {
  return positions.get(mint);
}

export function getAllPositions(): LpPosition[] {
  return Array.from(positions.values());
}

export function removePosition(mint: string): boolean {
  return positions.delete(mint);
}
