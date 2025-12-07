/**
 * helpers/liquidationCalculator.js
 * 
 * Liquidation-specific calculations for Venus Protocol
 * Replaces profitCalculator.js for liquidation strategy
 */

const ethers = require('ethers');

/**
 * Calculate health factor from Venus account data
 * Health Factor = (Collateral Value * Collateral Factor) / Borrow Value
 * 
 * @param {BigInt} totalCollateralUSD - Total collateral in USD (18 decimals)
 * @param {BigInt} totalBorrowUSD - Total borrow in USD (18 decimals)
 * @returns {BigInt} Health factor (18 decimals, 1e18 = 1.0)
 */
function calculateHealthFactor(totalCollateralUSD, totalBorrowUSD) {
    if (totalBorrowUSD === 0n) {
        return ethers.MaxUint256; // Infinite - no debt
    }
    
    if (totalCollateralUSD === 0n) {
        return 0n; // Zero - position is liquidatable
    }
    
    // Health Factor = collateral / borrow
    // Both values are already in USD with 18 decimals
    const healthFactor = (totalCollateralUSD * ethers.parseEther("1")) / totalBorrowUSD;
    
    return healthFactor;
}

/**
 * Check if position is liquidatable
 * Typically liquidatable when health factor < 1.0
 * 
 * @param {BigInt} healthFactor - Health factor (18 decimals)
 * @param {BigInt} threshold - Liquidation threshold (default 1.0 = 1e18)
 * @returns {boolean} True if liquidatable
 */
function isLiquidatable(healthFactor, threshold = ethers.parseEther("1.0")) {
    return healthFactor < threshold;
}

/**
 * Calculate maximum repayable amount
 * Most protocols allow liquidating up to 50% of the debt
 * 
 * @param {BigInt} borrowBalance - Current borrow balance
 * @param {number} closeFactor - Close factor (typically 0.5 = 50%)
 * @returns {BigInt} Maximum repayable amount
 */
function calculateMaxRepayAmount(borrowBalance, closeFactor = 0.5) {
    const closeFactorBigInt = BigInt(Math.floor(closeFactor * 1e18));
    return (borrowBalance * closeFactorBigInt) / ethers.parseEther("1");
}

/**
 * Calculate expected collateral received from liquidation
 * 
 * Formula: 
 * collateralSeized = repayAmount * liquidationIncentive * (debtPrice / collateralPrice)
 * 
 * @param {BigInt} repayAmount - Amount of debt being repaid
 * @param {BigInt} debtTokenPrice - Price of debt token (in USD, 18 decimals)
 * @param {BigInt} collateralTokenPrice - Price of collateral token (in USD, 18 decimals)
 * @param {BigInt} liquidationIncentive - Liquidation bonus (e.g., 1.08e18 = 8% bonus)
 * @returns {BigInt} Expected collateral amount to receive
 */
function calculateCollateralSeized(
    repayAmount,
    debtTokenPrice,
    collateralTokenPrice,
    liquidationIncentive
) {
    // repayAmount * debtPrice gives USD value of repayment
    const repayValueUSD = (repayAmount * debtTokenPrice) / ethers.parseEther("1");
    
    // Apply liquidation incentive (bonus)
    const repayValueWithBonus = (repayValueUSD * liquidationIncentive) / ethers.parseEther("1");
    
    // Convert to collateral token amount
    const collateralAmount = (repayValueWithBonus * ethers.parseEther("1")) / collateralTokenPrice;
    
    return collateralAmount;
}

/**
 * Calculate net profit from liquidation
 * 
 * @param {BigInt} repayAmount - Amount borrowed via flash loan
 * @param {BigInt} collateralReceived - Collateral received from liquidation
 * @param {BigInt} collateralToDebtRate - Exchange rate (collateral → debt token)
 * @param {BigInt} gasPrice - Current gas price in wei
 * @param {BigInt} estimatedGasUnits - Estimated gas for transaction
 * @param {number} swapSlippage - Expected slippage on DEX swap (e.g., 0.01 = 1%)
 * @returns {Object} Detailed profit breakdown
 */
function calculateLiquidationProfit(
    repayAmount,
    collateralReceived,
    collateralToDebtRate,
    gasPrice,
    estimatedGasUnits,
    swapSlippage = 0.01
) {
    // Calculate how much debt token we get from swapping collateral
    const collateralValueInDebt = (collateralReceived * collateralToDebtRate) / ethers.parseEther("1");
    
    // Apply slippage
    const slippageFactor = BigInt(Math.floor((1 - swapSlippage) * 1e18));
    const collateralValueAfterSlippage = (collateralValueInDebt * slippageFactor) / ethers.parseEther("1");
    
    // Calculate gas cost
    const gasCost = estimatedGasUnits * gasPrice;
    
    // Calculate gross profit (before gas)
    const grossProfit = collateralValueAfterSlippage > repayAmount 
        ? collateralValueAfterSlippage - repayAmount 
        : 0n;
    
    // Calculate net profit (after gas)
    const netProfit = grossProfit > gasCost ? grossProfit - gasCost : 0n;
    
    // Check profitability
    const isProfitable = netProfit > 0n;
    
    // Calculate ROI
    const roi = repayAmount > 0n 
        ? (netProfit * 10000n) / repayAmount 
        : 0n; // In basis points
    
    return {
        // Input values
        repayAmount,
        collateralReceived,
        
        // Calculations
        collateralValueInDebt,
        collateralValueAfterSlippage,
        gasCost,
        
        // Profit
        grossProfit,
        netProfit,
        
        // Status
        isProfitable,
        roi, // Basis points (e.g., 500 = 5%)
        
        // Human-readable
        breakdown: {
            repayAmount: ethers.formatEther(repayAmount),
            collateralReceived: ethers.formatEther(collateralReceived),
            collateralValue: ethers.formatEther(collateralValueInDebt),
            afterSlippage: ethers.formatEther(collateralValueAfterSlippage),
            gasCost: ethers.formatEther(gasCost),
            grossProfit: ethers.formatEther(grossProfit),
            netProfit: ethers.formatEther(netProfit),
            roi: `${(Number(roi) / 100).toFixed(2)}%`,
            isProfitable: isProfitable ? '✅ YES' : '❌ NO'
        }
    };
}

/**
 * Find optimal liquidation size
 * Iterates through different repay amounts to find maximum profit
 * 
 * @param {Object} position - Borrower position data
 * @param {Function} simulateLiquidation - Function to simulate liquidation at different sizes
 * @param {BigInt} minProfit - Minimum acceptable profit
 * @returns {Object|null} Optimal liquidation or null if none profitable
 */
async function findOptimalLiquidationSize(
    position,
    simulateLiquidation,
    minProfit
) {
    const { borrowBalance } = position;
    
    // Test different percentages: 10%, 20%, 30%, 40%, 50%
    const testPercentages = [0.1, 0.2, 0.3, 0.4, 0.5];
    
    let bestLiquidation = null;
    let maxProfit = 0n;
    
    for (const percentage of testPercentages) {
        const repayAmount = calculateMaxRepayAmount(borrowBalance, percentage);
        
        try {
            const result = await simulateLiquidation(repayAmount);
            
            if (result.isProfitable && result.netProfit >= minProfit) {
                if (result.netProfit > maxProfit) {
                    maxProfit = result.netProfit;
                    bestLiquidation = {
                        repayAmount,
                        percentage,
                        ...result
                    };
                }
            }
        } catch (error) {
            // Simulation failed, try next size
            continue;
        }
    }
    
    return bestLiquidation;
}

/**
 * Calculate liquidation incentive from Venus Comptroller
 * 
 * @param {BigInt} liquidationIncentiveMantissa - From comptroller (e.g., 1080000000000000000)
 * @returns {number} Incentive as percentage (e.g., 8.0 for 8%)
 */
function getLiquidationIncentivePercent(liquidationIncentiveMantissa) {
    const basePercent = Number(liquidationIncentiveMantissa) / 1e18;
    return (basePercent - 1) * 100;
}

/**
 * Estimate gas cost for liquidation transaction
 * Typical liquidation uses ~500k-800k gas on BSC
 * 
 * @param {BigInt} gasPrice - Current gas price
 * @param {boolean} isComplex - Complex liquidation (multiple tokens)
 * @returns {BigInt} Estimated gas cost in BNB
 */
function estimateLiquidationGasCost(gasPrice, isComplex = false) {
    const baseGas = 500000n; // Base gas for simple liquidation
    const complexGas = 800000n; // Gas for complex liquidation
    
    const gasUnits = isComplex ? complexGas : baseGas;
    return gasUnits * gasPrice;
}

/**
 * Format liquidation analysis for logging
 * 
 * @param {Object} analysis - Liquidation profit analysis
 * @returns {string} Formatted output
 */
function formatLiquidationAnalysis(analysis) {
    return `
═══════════════════════════════════════
      LIQUIDATION ANALYSIS REPORT
═══════════════════════════════════════
Repay Amount:       ${analysis.breakdown.repayAmount}
Collateral Received: ${analysis.breakdown.collateralReceived}
Collateral Value:   ${analysis.breakdown.collateralValue}
After Slippage:     ${analysis.breakdown.afterSlippage}

Gas Cost:           ${analysis.breakdown.gasCost}
═══════════════════════════════════════
GROSS PROFIT:       ${analysis.breakdown.grossProfit}
NET PROFIT:         ${analysis.breakdown.netProfit}
ROI:                ${analysis.breakdown.roi}
PROFITABLE:         ${analysis.breakdown.isProfitable}
═══════════════════════════════════════
    `;
}

/**
 * Check if liquidation is still valid (before execution)
 * Prevents wasted gas on positions already liquidated
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @param {string} borrower - Borrower address
 * @returns {Promise<boolean>} True if still liquidatable
 */
async function verifyLiquidatable(comptroller, borrower) {
    try {
        const [error, liquidity, shortfall] = await comptroller.getAccountLiquidity(borrower);
        
        if (error !== 0n) {
            return false;
        }
        
        // Shortfall > 0 means underwater
        return shortfall > 0n;
    } catch (error) {
        console.error('Error verifying liquidation:', error.message);
        return false;
    }
}

module.exports = {
    calculateHealthFactor,
    isLiquidatable,
    calculateMaxRepayAmount,
    calculateCollateralSeized,
    calculateLiquidationProfit,
    findOptimalLiquidationSize,
    getLiquidationIncentivePercent,
    estimateLiquidationGasCost,
    formatLiquidationAnalysis,
    verifyLiquidatable
};
