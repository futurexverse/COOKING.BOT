import { ethers } from "ethers";

export const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
export const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
export const WETH_ADDRESS = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const CHAIN_ID = 4663;

export const UNISWAP_V3_ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) calldata params) external payable returns (uint256 amountOut)",
  "function exactInput(tuple(bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) calldata params) external payable returns (uint256 amountOut)",
];

export const UNISWAP_V3_QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) calldata params) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

export const FEE_TIERS = [500, 3000, 10000];

export function getRouterContract(signer: ethers.Signer): ethers.Contract {
  return new ethers.Contract(UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, signer);
}

export function getQuoterContract(provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(UNISWAP_V3_QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
}

export function getERC20Contract(address: string, signer: ethers.Signer): ethers.Contract {
  return new ethers.Contract(address, ERC20_ABI, signer);
}
