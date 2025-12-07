// scripts/sepoliaMarketMaker.js
// A plain Ethers.js script, run with `node`
const { ethers } = require("ethers");
require("dotenv").config();
const ISwapRouterABI = require('../abi/ISwapRouter.json');

// --- CONFIGURATION ---
const MOCK_TOKEN_ADDRESS = process.env.MOCK_LINK_ADDRESS; // Example using LINK
const MOCK_TOKEN_SYMBOL = "LINK";
const WETH_TO_SEED = ethers.parseEther("1");
const MOCK_TOKEN_TO_SEED = ethers.parseEther("100");
const WETH_TO_SWAP = ethers.parseEther("0.5");

// --- ADDRESSES (ETHEREUM SEPOLIA - ALL LOWERCASE) ---
const WETH_ADDRESS = "0x7b79995e5f793a07bc00c21412e50ecae098e7f9";
const UNISWAP_POSITION_MANAGER = "0x1238536071e1c577a6022dfc2c99f36b28118088";
const SUSHISWAP_ROUTER_ADDRESS_V2 = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";

const INonfungiblePositionManagerABI = [ "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable" ];
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)"];
const IUniswapV2RouterABI = ["function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint, uint, uint)", "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)"];
const MOCK_TOKEN_ABI = ["function approve(address spender, uint256 amount) external returns (bool)"];

// --- SCRIPT START ---
async function main() {
    console.log("--- Starting Sepolia Market Maker Script (Plain Ethers.js) ---");
    
    // 1. Setup Provider and Signer (No Hardhat Magic)
    const provider = new ethers.JsonRpcProvider(process.env.ETH_SEPOLIA_RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log(`Using real wallet: ${wallet.address}`);

    // Get contract instances
    const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, wallet);
    const mockTokenContract = new ethers.Contract(MOCK_TOKEN_ADDRESS, MOCK_TOKEN_ABI, wallet);
    const uniV3PositionManager = new ethers.Contract(UNISWAP_POSITION_MANAGER, INonfungiblePositionManagerABI, wallet);
    const sushiV2Router = new ethers.Contract(SUSHISWAP_ROUTER_ADDRESS_V2, IUniswapV2RouterABI, wallet);

    console.log("\n--- Phase 1: Adding Liquidity to DEXs ---");
    
    // Check balances before starting
    const ethBalance = await provider.getBalance(wallet.address);
    console.log(`- Starting ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);
    // NOTE: You must have WETH before running. Go to Uniswap and wrap 1.1 ETH into WETH.
    // If you don't have WETH, the next transaction will fail.
    
    console.log(`Adding ${ethers.formatEther(WETH_TO_SEED)} WETH and ${ethers.formatEther(MOCK_TOKEN_TO_SEED)} ${MOCK_TOKEN_SYMBOL} to Uniswap V3...`);
    await wethContract.approve(UNISWAP_POSITION_MANAGER, WETH_TO_SEED);
    await mockTokenContract.approve(UNISWAP_POSITION_MANAGER, MOCK_TOKEN_TO_SEED);
    const uniParams = {
        token0: WETH_ADDRESS < MOCK_TOKEN_ADDRESS ? WETH_ADDRESS : MOCK_TOKEN_ADDRESS,
        token1: WETH_ADDRESS > MOCK_TOKEN_ADDRESS ? WETH_ADDRESS : MOCK_TOKEN_ADDRESS,
        fee: 3000, tickLower: -887220, tickUpper: 887220,
        amount0Desired: WETH_ADDRESS < MOCK_TOKEN_ADDRESS ? WETH_TO_SEED : MOCK_TOKEN_TO_SEED,
        amount1Desired: WETH_ADDRESS > MOCK_TOKEN_ADDRESS ? WETH_TO_SEED : MOCK_TOKEN_TO_SEED,
        amount0Min: 0, amount1Min: 0, recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 10,
    };
    const uniMintTx = await uniV3PositionManager.mint(uniParams);
    await uniMintTx.wait();
    console.log("✅ Uniswap V3 Pool seeded.");
    
    console.log(`Adding ${ethers.formatEther(WETH_TO_SEED)} WETH and ${ethers.formatEther(MOCK_TOKEN_TO_SEED)} ${MOCK_TOKEN_SYMBOL} to Sushiswap V2...`);
    await mockTokenContract.approve(SUSHISWAP_ROUTER_ADDRESS_V2, MOCK_TOKEN_TO_SEED);
    const sushiAddTx = await sushiV2Router.addLiquidityETH(
        MOCK_TOKEN_ADDRESS, MOCK_TOKEN_TO_SEED, 0, 0, wallet.address,
        Math.floor(Date.now() / 1000) + 60 * 10, { value: WETH_TO_SEED }
    );
    await sushiAddTx.wait();
    console.log("✅ Sushiswap V2 Pool seeded.");

    console.log("\n--- Phase 2: Manipulating Price on Sushiswap ---");
    const sushiSwapTx = await sushiV2Router.swapExactETHForTokens(
        0, [WETH_ADDRESS, MOCK_TOKEN_ADDRESS], wallet.address,
        Math.floor(Date.now() / 1000) + 60 * 10, { value: WETH_TO_SWAP }
    );
    await sushiSwapTx.wait();
    console.log(`✅ Sushiswap price manipulated. Arbitrage opportunity is now LIVE.`);
}

main().catch(error => {
    console.error("A fatal error occurred:", error);
    process.exit(1);
});
