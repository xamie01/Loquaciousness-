/**
 * helpers/profitCalculator.js
 * 
 * Correct flashloan and profit calculations for arbitrage bot
 * 
 * KEY CONCEPTS:
 * 1. Flashloan Fee: You borrow X and must repay X + (X * fee%)
 *    - If you borrow 1 ETH at 0.09% fee, you must repay 1.0009 ETH
 * 
 * 2. Trade Flow: 
 *    - Borrow X of token A via flashloan
 *    - Swap X token A → Y token B on DEX1
 *    - Swap Y token B → Z token A on DEX2
 *    - Must have Z >= X + flashloan_fee
 *    - Keep Z - (X + flashloan_fee) - gas_cost as profit
 * 
 * 3. Critical checks:
 *    - amountOut2 must be >= (amountIn + flashloan_fee + gas_cost)
 *    - Only then is profit = amountOut2 - amountIn - flashloan_fee - gas_cost
 */

const ethers = require('ethers');

/**
 * Calculate flashloan repayment amount (borrowed + fee)
 * 
 * @param {BigInt} borrowAmount - Amount borrowed in wei
 * @param {number} feePercent - Fee as decimal (0.0009 = 0.09%)
 * @returns {Object} { flashAmount, feeAmount, totalRepay }
 */
function calculateFlashloanRepayment(borrowAmount, feePercent) {
  if (!borrowAmount || borrowAmount <= 0n) {
    throw new Error("borrowAmount must be a positive BigInt");
  }
  
  if (feePercent < 0 || feePercent > 1) {
    throw new Error("feePercent must be between 0 and 1");
  }
  
  // Convert fee percentage to basis points
  // 0.0009 (0.09%) * 10000 = 9 basis points
  const feeBasisPoints = BigInt(Math.floor(feePercent * 10000));
  
  // Calculate fee: amount * (basisPoints / 10000)
  const feeAmount = (borrowAmount * feeBasisPoints) / 10000n;
  
  // Total to repay = borrowed + fee
  const totalRepay = borrowAmount + feeAmount;
  
  return {
    flashAmount: borrowAmount,
    feeAmount: feeAmount,
    totalRepay: totalRepay,
    feePercent: feePercent,
    feeBasisPoints: feeBasisPoints
  };
}

/**
 * Calculate net profit accounting for ALL costs
 * This is the CORE function - use this for all profit calculations
 * 
 * @param {BigInt} amountIn - Initial borrow amount (token0 to borrow)
 * @param {BigInt} amountAfterFirstSwap - Token1 amount after first DEX swap
 * @param {BigInt} amountAfterSecondSwap - Token0 amount after second DEX swap (final amount)
 * @param {BigInt} gasPrice - Current gas price in wei
 * @param {number} flashLoanFeePercent - Flashloan fee as decimal (0.0009)
 * @param {BigInt} estimatedGasUnits - Estimated gas units for entire tx
 * 
 * @returns {Object} Comprehensive profit breakdown
 */
function calculateTrueNetProfit(
  amountIn,
  amountAfterFirstSwap,
  amountAfterSecondSwap,
  gasPrice,
  flashLoanFeePercent,
  estimatedGasUnits
) {
  // Validate inputs
  if (!amountIn || amountIn <= 0n) {
    throw new Error("amountIn must be positive BigInt");
  }
  if (!gasPrice || gasPrice <= 0n) {
    throw new Error("gasPrice must be positive BigInt");
  }
  if (!estimatedGasUnits || estimatedGasUnits <= 0n) {
    throw new Error("estimatedGasUnits must be positive BigInt");
  }
  
  // 1. Calculate flashloan costs
  const flashloanRepay = calculateFlashloanRepayment(amountIn, flashLoanFeePercent);
  
  // 2. Calculate gas cost in wei
  const gasCostInWei = estimatedGasUnits * gasPrice;
  
  // 3. Calculate total costs (what we MUST pay)
  const totalCostsRequired = flashloanRepay.totalRepay + gasCostInWei;
  
  // 4. Calculate gross profit (received vs borrowed)
  const grossProfit = amountAfterSecondSwap - amountIn;
  
  // 5. Calculate net profit (after all costs)
  const netProfit = amountAfterSecondSwap - totalCostsRequired;
  
  // 6. Check profitability: do we receive enough to cover all costs?
  const isProfitable = amountAfterSecondSwap >= totalCostsRequired;
  
  // 7. Calculate efficiency metrics
  const profitMargin = isProfitable && amountAfterSecondSwap > 0n 
    ? ((netProfit * 10000n) / amountAfterSecondSwap)
    : 0n;
  
  return {
    // Core amounts
    amountBorrowed: amountIn,
    amountReceivedAfterSwaps: amountAfterSecondSwap,
    
    // Costs breakdown
    flashloanFeeAmount: flashloanRepay.feeAmount,
    flashloanTotalRepay: flashloanRepay.totalRepay,
    gasCostInWei: gasCostInWei,
    totalCostsRequired: totalCostsRequired,
    
    // Profit calculation
    grossProfit: grossProfit,      // Before costs
    netProfit: netProfit,           // After all costs
    profitMarginBps: profitMargin,  // In basis points (10000 = 100%)
    
    // Status
    isProfitable: isProfitable,
    
    // Intermediate swap amounts (for analysis)
    amountAfterFirstSwap: amountAfterFirstSwap,
    
    // Human-readable breakdown
    breakdown: {
      amountBorrowed: ethers.formatEther(amountIn),
      flashloanFee: ethers.formatEther(flashloanRepay.feeAmount),
      flashloanFeePercent: `${(flashLoanFeePercent * 100).toFixed(4)}%`,
      mustRepayFlashloan: ethers.formatEther(flashloanRepay.totalRepay),
      gasUsed: `${estimatedGasUnits.toString()} units`,
      gasCost: ethers.formatEther(gasCostInWei),
      totalCostsRequired: ethers.formatEther(totalCostsRequired),
      amountReceived: ethers.formatEther(amountAfterSecondSwap),
      grossProfit: ethers.formatEther(grossProfit),
      netProfit: ethers.formatEther(netProfit),
      profitMarginPercent: `${(Number(profitMargin) / 100).toFixed(2)}%`,
      isProfitable: isProfitable ? '✅ YES' : '❌ NO'
    }
  };
}

/**
 * Calculate minimum amount needed from second swap
 * This ensures slippage protection on BOTH swaps
 * 
 * Formula:
 * amountOutMin = (firstSwapOutput * (10000 - slippage)) / 10000
 * But also ensure: amountOutMin >= (amountBorrowed + flashloanFee + gasCost)
 * 
 * @param {BigInt} amountFromFirstSwap - Output of first DEX swap
 * @param {number} slippageTolerance - Slippage in basis points (50 = 0.5%)
 * @param {BigInt} flashloanRepayRequired - Total to repay flashloan
 * @param {BigInt} gasCostEstimate - Estimated gas cost in wei
 * 
 * @returns {BigInt} Minimum amount required from second swap
 */
function calculateAmountOutMinimum(
  amountFromFirstSwap,
  slippageTolerance,
  flashloanRepayRequired,
  gasCostEstimate
) {
  if (!amountFromFirstSwap || amountFromFirstSwap <= 0n) {
    throw new Error("amountFromFirstSwap must be positive BigInt");
  }
  if (slippageTolerance < 0 || slippageTolerance > 10000) {
    throw new Error("slippageTolerance must be between 0 and 10000 basis points");
  }
  
  // Apply slippage tolerance to first swap output
  // This protects against price impact on the second swap
  const withSlippage = (amountFromFirstSwap * BigInt(10000 - slippageTolerance)) / 10000n;
  
  // The ABSOLUTE MINIMUM is enough to repay flashloan + gas
  const absoluteMinimum = flashloanRepayRequired + gasCostEstimate;
  
  // Return whichever is higher
  // This ensures we don't accept prices that would result in losses
  return withSlippage > absoluteMinimum ? withSlippage : absoluteMinimum;
}

/**
 * Analyze multiple amounts to find the best opportunity
 * Used by bot to scan across different trade sizes
 * 
 * @param {BigInt} startAmount - Starting amount to test
 * @param {BigInt} maxAmount - Maximum amount to test
 * @param {BigInt} step - Step size between tests
 * @param {Function} getQuoteCallback - Callback to get swap quotes
 * @param {Object} params - { token0, token1, feeTier, dex1, dex2, gasPrice, feePercent }
 * 
 * @returns {Object} Best opportunity found or null
 */
async function findBestOpportunity(
  startAmount,
  maxAmount,
  step,
  getQuoteCallback,
  params
) {
  const {
    token0,
    token1,
    feeTier,
    quoter1,
    quoter2,
    gasPrice,
    feePercent,
    minProfitThreshold = 0n
  } = params;
  
  let bestOpportunity = null;
  let bestProfit = -Infinity;
  
  let testAmount = startAmount;
  
  while (testAmount <= maxAmount) {
    try {
      // Get quotes for this amount
      const quote1 = await getQuoteCallback(quoter1, token0.address, token1.address, testAmount, feeTier);
      if (quote1.amountOut === 0n) {
        testAmount += step;
        continue;
      }
      
      const quote2 = await getQuoteCallback(quoter2, token1.address, token0.address, quote1.amountOut, feeTier);
      if (quote2.amountOut === 0n) {
        testAmount += step;
        continue;
      }
      
      // Estimate gas (typical for V3 dual swaps: ~500k units)
      const estimatedGas = 500000n;
      
      // Calculate profit
      const profitAnalysis = calculateTrueNetProfit(
        testAmount,
        quote1.amountOut,
        quote2.amountOut,
        gasPrice,
        feePercent,
        estimatedGas
      );
      
      // Check if profitable and above minimum threshold
      if (profitAnalysis.isProfitable && profitAnalysis.netProfit >= minProfitThreshold) {
        // Track if this is better than previous best
        if (Number(profitAnalysis.netProfit) > bestProfit) {
          bestProfit = Number(profitAnalysis.netProfit);
          bestOpportunity = {
            testAmount: testAmount,
            amountFromFirstSwap: quote1.amountOut,
            amountFromSecondSwap: quote2.amountOut,
            profitAnalysis: profitAnalysis,
            quote1: quote1,
            quote2: quote2
          };
        }
      }
      
    } catch (error) {
      console.error(`Error analyzing amount ${ethers.formatEther(testAmount)}: ${error.message}`);
    }
    
    testAmount += step;
  }
  
  return bestOpportunity;
}

/**
 * Format profit analysis for logging/display
 */
function formatProfitAnalysis(analysis) {
  return `
═══════════════════════════════════════
        PROFIT ANALYSIS REPORT
═══════════════════════════════════════
Borrowed:           ${analysis.breakdown.amountBorrowed}
Flashloan Fee:      ${analysis.breakdown.flashloanFee} (${analysis.breakdown.flashloanFeePercent})
Must Repay:         ${analysis.breakdown.mustRepayFlashloan}

Gas Cost:           ${analysis.breakdown.gasCost}
Total Costs:        ${analysis.breakdown.totalCostsRequired}

Received:           ${analysis.breakdown.amountReceived}
Gross Profit:       ${analysis.breakdown.grossProfit}
═══════════════════════════════════════
NET PROFIT:         ${analysis.breakdown.netProfit}
Profit Margin:      ${analysis.breakdown.profitMarginPercent}
PROFITABLE:         ${analysis.breakdown.isProfitable}
═══════════════════════════════════════
  `;
}

module.exports = {
  calculateFlashloanRepayment,
  calculateTrueNetProfit,
  calculateAmountOutMinimum,
  findBestOpportunity,
  formatProfitAnalysis
};
