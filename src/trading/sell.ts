import { ethers } from "ethers";
import { getWallet, getProvider } from "../wallet/wallet.js";
import {
  getRouterContract,
  getERC20Contract,
  WETH_ADDRESS,
  FEE_TIERS,
} from "./router.js";

export interface SellResult {
  success: boolean;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  tokenAddress?: string;
  error?: string;
}

export async function sellToken(
  tokenAddress: string,
  percentage: number = 100,
  slippagePct: number = 5
): Promise<SellResult> {
  const wallet = getWallet();

  try {
    const tokenContract = getERC20Contract(tokenAddress, wallet);
    const decimals = await tokenContract.decimals();
    const symbol = await tokenContract.symbol();
    const balance = await tokenContract.balanceOf(wallet.address);

    if (balance === 0n) {
      return { success: false, error: `No ${symbol} balance to sell`, tokenAddress };
    }

    const sellAmount = (balance * BigInt(Math.floor(percentage * 100))) / 10000n;

    const allowance = await tokenContract.allowance(wallet.address, "0xE592427A0AEce92De3Edee1F18E0157C05861564");
    if (allowance < sellAmount) {
      console.log(`[Sell] Approving ${symbol} for Uniswap Router...`);
      const approveTx = await tokenContract.approve(
        "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        ethers.MaxUint256
      );
      await approveTx.wait();
      console.log(`[Sell] Approved ${symbol}`);
    }

    const minOut = await quoteSell(tokenAddress, sellAmount);
    const minOutWithSlippage = minOut * BigInt(Math.floor((100 - slippagePct) * 100)) / 10000n;

    const router = getRouterContract(wallet);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const params = {
      tokenIn: tokenAddress,
      tokenOut: WETH_ADDRESS,
      fee: FEE_TIERS[1],
      recipient: wallet.address,
      deadline,
      amountIn: sellAmount,
      amountOutMinimum: minOutWithSlippage,
      sqrtPriceLimitX96: 0,
    };

    console.log(`[Sell] Selling ${ethers.formatUnits(sellAmount, decimals)} ${symbol}...`);
    const tx = await router.exactInputSingle(params);
    const receipt = await tx.wait();

    const ethBalance = await getProvider().getBalance(wallet.address);

    console.log(`[Sell] Success! Tx: ${receipt.hash}`);
    console.log(`[Sell] Wallet ETH balance: ${ethers.formatEther(ethBalance)}`);

    return {
      success: true,
      txHash: receipt.hash,
      amountIn: ethers.formatUnits(sellAmount, decimals),
      amountOut: ethers.formatEther(minOut),
      tokenAddress,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sell] Failed:`, msg);
    return { success: false, error: msg, tokenAddress };
  }
}

async function quoteSell(tokenAddress: string, amountIn: bigint): Promise<bigint> {
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
          tokenIn: tokenAddress,
          tokenOut: WETH_ADDRESS,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0,
        });
        return result[0];
      } catch {
        continue;
      }
    }
    return 0n;
  } catch {
    return 0n;
  }
}

export async function getTokenBalance(tokenAddress: string): Promise<{ balance: string; decimals: number; symbol: string }> {
  const wallet = getWallet();
  const contract = getERC20Contract(tokenAddress, wallet);
  const balance = await contract.balanceOf(wallet.address);
  const decimals = await contract.decimals();
  const symbol = await contract.symbol();
  return {
    balance: ethers.formatUnits(balance, decimals),
    decimals,
    symbol,
  };
}
