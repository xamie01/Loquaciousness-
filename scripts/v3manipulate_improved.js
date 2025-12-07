/**
 * scripts/v3manipulate_optimal.js
 * 
 * Optimized for 0.7 WETH + 1,092 LINK liquidity pools
 * Uses 1% of pool (0.007 WETH) for safe price manipulation
 * 
 * Usage: npx hardhat run scripts/v3manipulate_optimal.js --network sepolia
 */

require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const SEPOLIA_WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

const UNISWAP_SEPOLIA = {
  V2_ROUTER: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
  V3_ROUTER: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  V2_FACTORY: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6",
  V3_FACTORY: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c"
};

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)"
];

const V2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)"
];

const V2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)"
];

async function checkAndCalculateSwapAmount(factory, tokenA, tokenB, signer) {
  const v2Factory = new ethers.Contract(factory, V2_FACTORY_ABI, signer);
  const pairAddress = await v2Factory.getPair(tokenA, tokenB);
  
  if (pairAddress === ethers.ZeroAddress) {
    throw new Error("V2 pool doesn't exist!");
  }
  
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, signer);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = await pair.token0();
  
  const wethReserve = token0.toLowerCase() === tokenA.toLowerCase() ? reserve0 : reserve1;
  const linkReserve = token0.toLowerCase() === tokenA.toLowerCase() ? reserve1 : reserve0;
  
  console.log(`\n📊 V2 POOL ANALYSIS:`);
  console.log(`   WETH Reserve: ${ethers.formatEther(wethReserve)}`);
  console.log(`   LINK Reserve: ${ethers.formatEther(linkReserve)}`);
  
  if (wethReserve === 0n) {
    throw new Error("Pool has no WETH liquidity!");
  }
  
  // Calculate 1% of pool as safe swap amount
  const onePercent = wethReserve / 100n;
  const halfPercent = wethReserve / 200n;
  const twoPercent = wethReserve / 50n;
  
  console.log(`\n💡 SAFE SWAP AMOUNTS:`);
  console.log(`   0.5% of pool: ${ethers.formatEther(halfPercent)} WETH`);
  console.log(`   1.0% of pool: ${ethers.formatEther(onePercent)} WETH ⭐ RECOMMENDED`);
  console.log(`   2.0% of pool: ${ethers.formatEther(twoPercent)} WETH`);
  
  return {
    wethReserve,
    linkReserve,
    recommendedAmount: onePercent,
    conservativeAmount: halfPercent,
    aggressiveAmount: twoPercent
  };
}

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  OPTIMAL V2↔V3 PRICE MANIPULATION`);
  console.log(`  Designed for: 0.7 WETH + 1,092 LINK pools`);
  console.log(`${"=".repeat(70)}\n`);

  const [signer] = await ethers.getSigners();
  console.log(`📍 Signer: ${signer.address}`);

  let BASE_TOKEN = process.env.ARB_FOR || SEPOLIA_WETH;
  let TARGET_TOKEN = process.env.ARB_AGAINST_TOKENS?.split(',')[0].trim();

  if (!TARGET_TOKEN) {
    console.error("❌ Set ARB_AGAINST_TOKENS in .env");
    process.exit(1);
  }

  const baseToken = new ethers.Contract(BASE_TOKEN, ERC20_ABI, signer);
  const targetToken = new ethers.Contract(TARGET_TOKEN, ERC20_ABI, signer);
  
  const baseSymbol = await baseToken.symbol();
  const targetSymbol = await targetToken.symbol();

  console.log(`\n💱 TOKEN PAIR:`);
  console.log(`   ${baseSymbol}: ${BASE_TOKEN}`);
  console.log(`   ${targetSymbol}: ${TARGET_TOKEN}`);

  // Analyze pool and get recommended swap amount
  const poolAnalysis = await checkAndCalculateSwapAmount(
    UNISWAP_SEPOLIA.V2_FACTORY,
    BASE_TOKEN,
    TARGET_TOKEN,
    signer
  );

  // Use recommended amount (1% of pool)
  const SWAP_AMOUNT = poolAnalysis.recommendedAmount;
  const swapPercent = (Number(SWAP_AMOUNT) / Number(poolAnalysis.wethReserve)) * 100;

  console.log(`\n✅ SELECTED SWAP AMOUNT: ${ethers.formatEther(SWAP_AMOUNT)} ${baseSymbol}`);
  console.log(`   This is ${swapPercent.toFixed(2)}% of the pool (safe range)\n`);

  // Check balance
  const balance = await baseToken.balanceOf(signer.address);
  console.log(`💼 YOUR BALANCE: ${ethers.formatEther(balance)} ${baseSymbol}`);
  
  if (balance < SWAP_AMOUNT) {
    console.error(`❌ Insufficient balance! Need ${ethers.formatEther(SWAP_AMOUNT)}`);
    process.exit(1);
  }

  // Get initial prices
  const v2Router = new ethers.Contract(UNISWAP_SEPOLIA.V2_ROUTER, V2_ROUTER_ABI, signer);
  const testAmount = ethers.parseEther("1.0");
  const initialPrice = await v2Router.getAmountsOut(testAmount, [BASE_TOKEN, TARGET_TOKEN]);
  
  console.log(`\n📈 INITIAL V2 PRICE: 1 ${baseSymbol} = ${ethers.formatEther(initialPrice[1])} ${targetSymbol}`);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`🔄 EXECUTING MANIPULATION`);
  console.log(`${"=".repeat(70)}\n`);

  const v3Router = new ethers.Contract(UNISWAP_SEPOLIA.V3_ROUTER, V3_ROUTER_ABI, signer);

  try {
    // ============================================
    // STEP 1: BUY ON V2 (WETH → LINK)
    // ============================================

    console.log(`Step 1️⃣ : BUY on V2`);
    console.log(`   Swapping ${ethers.formatEther(SWAP_AMOUNT)} ${baseSymbol} → ${targetSymbol}`);

    const v2Allowance = await baseToken.allowance(signer.address, UNISWAP_SEPOLIA.V2_ROUTER);
    if (v2Allowance < SWAP_AMOUNT) {
      console.log(`   → Approving...`);
      await (await baseToken.approve(UNISWAP_SEPOLIA.V2_ROUTER, ethers.MaxUint256)).wait();
      console.log(`   ✅ Approved`);
    }

    const deadline = Math.floor(Date.now() / 1000) + 1200;
    const v2Tx = await v2Router.swapExactTokensForTokens(
      SWAP_AMOUNT,
      0,
      [BASE_TOKEN, TARGET_TOKEN],
      signer.address,
      deadline,
      { gasLimit: 500000 }
    );

    await v2Tx.wait();
    const receivedAmount = await targetToken.balanceOf(signer.address);
    
    console.log(`   ✅ Received: ${ethers.formatEther(receivedAmount)} ${targetSymbol}`);
    console.log(`   TX: ${v2Tx.hash}\n`);

    // ============================================
    // STEP 2: SELL ON V3 (LINK → WETH)
    // ============================================

    console.log(`Step 2️⃣ : SELL on V3`);
    console.log(`   Swapping ${ethers.formatEther(receivedAmount)} ${targetSymbol} → ${baseSymbol}`);

    const v3Allowance = await targetToken.allowance(signer.address, UNISWAP_SEPOLIA.V3_ROUTER);
    if (v3Allowance < receivedAmount) {
      console.log(`   → Approving...`);
      await (await targetToken.approve(UNISWAP_SEPOLIA.V3_ROUTER, ethers.MaxUint256)).wait();
      console.log(`   ✅ Approved`);
    }

    const v3Params = {
      tokenIn: TARGET_TOKEN,
      tokenOut: BASE_TOKEN,
      fee: 3000,
      recipient: signer.address,
      amountIn: receivedAmount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0
    };

    const v3Tx = await v3Router.exactInputSingle(v3Params, { gasLimit: 800000 });
    await v3Tx.wait();
    
    console.log(`   ✅ Complete`);
    console.log(`   TX: ${v3Tx.hash}\n`);

    // ============================================
    // RESULTS
    // ============================================

    const finalBalance = await baseToken.balanceOf(signer.address);
    const finalPrice = await v2Router.getAmountsOut(testAmount, [BASE_TOKEN, TARGET_TOKEN]);
    
    const initialPriceNum = Number(ethers.formatEther(initialPrice[1]));
    const finalPriceNum = Number(ethers.formatEther(finalPrice[1]));
    const priceChange = ((initialPriceNum - finalPriceNum) / initialPriceNum) * 100;

    console.log(`${"=".repeat(70)}`);
    console.log(`📊 RESULTS`);
    console.log(`${"=".repeat(70)}\n`);
    
    console.log(`💰 BALANCES:`);
    console.log(`   Before: ${ethers.formatEther(balance)} ${baseSymbol}`);
    console.log(`   After: ${ethers.formatEther(finalBalance)} ${baseSymbol}`);
    console.log(`   Cost: ${ethers.formatEther(balance - finalBalance)} ${baseSymbol}\n`);
    
    console.log(`📈 PRICE MOVEMENT (V2):`);
    console.log(`   Before: 1 ${baseSymbol} = ${initialPriceNum.toFixed(2)} ${targetSymbol}`);
    console.log(`   After: 1 ${baseSymbol} = ${finalPriceNum.toFixed(2)} ${targetSymbol}`);
    console.log(`   Change: ${priceChange.toFixed(2)}%\n`);

    if (Math.abs(priceChange) >= 1) {
      console.log(`✅ SUCCESS! Created ${Math.abs(priceChange).toFixed(2)}% price gap`);
      console.log(`   Your bot should now detect arbitrage opportunities!\n`);
      
      if (Math.abs(priceChange) < 2) {
        console.log(`💡 TIP: For bigger gaps, run this script 2-3 more times`);
        console.log(`   Or increase to 2% swaps: ${ethers.formatEther(poolAnalysis.aggressiveAmount)} ${baseSymbol}\n`);
      }
    } else {
      console.log(`⚠️  Small gap: ${Math.abs(priceChange).toFixed(2)}%`);
      console.log(`   Run script again or try larger amount\n`);
    }

    console.log(`${"=".repeat(70)}\n`);

  } catch (error) {
    console.error(`\n❌ ERROR:`, error.message);
    if (error.reason) console.error(`   Reason: ${error.reason}`);
    process.exit(1);
  }
}

main().catch(console.error);
