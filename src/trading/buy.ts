import { ethers } from "ethers";
import { getWallet, getProvider, getGasPrice } from "../wallet/wallet.js";
import {
  getRouterContract,
  getERC20Contract,
  WETH_ADDRESS,
  FEE_TIERS,
} from "./router.js";

export interface BuyResult {
  success: boolean;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  tokenAddress?: string;
  error?: string;
}

export async function buyToken(
  tokenAddress: string,
  ethAmount: string,
  slippagePct: number = 5
): Promise<BuyResult> {
  const wallet = getWallet();
  const provider = getProvider();

  try {
    const amountIn = ethers.parseEther(ethAmount);
    const { wei: balance } = await (await import("../wallet/wallet.js")).getBalance();
    if (balance < amountIn + ethers.parseEther("0.001")) {
      return { success: false, error: "Insufficient ETH balance for trade + gas" };
    }

    const tokenContract = getERC20Contract(tokenAddress, wallet);
    const decimals = await tokenContract.decimals();
    const symbol = await tokenContract.symbol();

    const amountOutMin = await quoteBuy(tokenAddress, amountIn, decimals);
    const minOutWithSlippage = amountOutMin * BigInt(Math.floor((100 - slippagePct) * 100)) / 10000n;

    const router = getRouterContract(wallet);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const params = {
      tokenIn: WETH_ADDRESS,
      tokenOut: tokenAddress,
      fee: FEE_TIERS[1],
      recipient: wallet.address,
      deadline,
      amountIn,
      amountOutMinimum: minOutWithSlippage,
      sqrtPriceLimitX96: 0,
    };

    console.log(`[Buy] Buying ${symbol} with ${ethAmount} ETH...`);
    const tx = await router.exactInputSingle(params, { value: amountIn });
    const receipt = await tx.wait();

    const amountOut = await tokenContract.balanceOf(wallet.address);

    console.log(`[Buy] Success! Tx: ${receipt.hash}`);
    console.log(`[Buy] Received ${ethers.formatUnits(amountOut, decimals)} ${symbol}`);

    return {
      success: true,
      txHash: receipt.hash,
      amountIn: ethAmount,
      amountOut: ethers.formatUnits(amountOut, decimals),
      tokenAddress,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Buy] Failed:`, msg);
    return { success: false, error: msg, tokenAddress };
  }
}

async function quoteBuy(
  tokenAddress: string,
  amountIn: bigint,
  decimals: number
): Promise<bigint> {
  const provider = getProvider();
  try {
    const quoterAddr = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
    const quoterABI = [
      "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) calldata params) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
    ];
    const quoter = new ethers.Contract(quoterAddr, quoterABI, provider);

    for (const fee of FEE_TIERS) {
      try {
        const result = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: WETH_ADDRESS,
          tokenOut: tokenAddress,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0,
        });
        return result[0];
      } catch {
        continue;
      }
    }
    console.warn("[Buy] Quoter failed for all fee tiers, using zero minimum");
    return 0n;
  } catch {
    return 0n;
  }
}
