/**
 * helpers/venusHelpers.js
 * 
 * Venus Protocol interaction helpers
 * Replaces helpers.js for liquidation strategy
 */

const { ethers } = require("ethers");

// ABIs for Venus contracts
const COMPTROLLER_ABI = [
    "function getAccountLiquidity(address account) external view returns (uint, uint, uint)",
    "function getAllMarkets() external view returns (address[])",
    "function liquidationIncentiveMantissa() external view returns (uint)",
    "function markets(address) external view returns (bool, uint, bool)",
    "function closeFactorMantissa() external view returns (uint)"
];

const VTOKEN_ABI = [
    "function borrowBalanceCurrent(address account) external returns (uint)",
    "function borrowBalanceStored(address account) external view returns (uint)",
    "function balanceOfUnderlying(address owner) external returns (uint)",
    "function balanceOf(address owner) external view returns (uint)",
    "function exchangeRateCurrent() external returns (uint)",
    "function exchangeRateStored() external view returns (uint)",
    "function underlying() external view returns (address)",
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)",
    "function liquidateBorrow(address borrower, uint repayAmount, address vTokenCollateral) external returns (uint)",
    "function redeem(uint redeemTokens) external returns (uint)",
    "function redeemUnderlying(uint redeemAmount) external returns (uint)"
];

const ORACLE_ABI = [
    "function getUnderlyingPrice(address vToken) external view returns (uint)"
];

const ERC20_ABI = [
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)",
    "function balanceOf(address) external view returns (uint256)"
];

/**
 * Get Venus account data for a borrower
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @param {string} borrowerAddress - Address to check
 * @returns {Object} Account data
 */
async function getVenusAccountData(comptroller, borrowerAddress) {
    try {
        const [error, liquidity, shortfall] = await comptroller.getAccountLiquidity(borrowerAddress);
        
        if (error !== 0n) {
            throw new Error(`Comptroller error: ${error}`);
        }
        
        // Calculate health factor
        // If shortfall > 0, position is underwater
        // healthFactor = liquidity / (liquidity + shortfall)
        const totalLiquidity = liquidity + shortfall;
        const healthFactor = totalLiquidity > 0n 
            ? (liquidity * ethers.parseEther("1")) / totalLiquidity
            : ethers.MaxUint256;
        
        return {
            liquidity,      // Available to borrow (USD, 18 decimals)
            shortfall,      // How underwater the position is (USD, 18 decimals)
            healthFactor,   // Calculated health factor (18 decimals)
            isLiquidatable: shortfall > 0n
        };
    } catch (error) {
        console.error(`Error getting account data: ${error.message}`);
        return null;
    }
}

/**
 * Get all borrow positions for an address
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @param {Object} oracle - Venus PriceOracle contract
 * @param {string} borrowerAddress - Address to check
 * @param {Object} provider - Ethers provider
 * @returns {Array} Array of borrow positions
 */
async function getAllBorrowPositions(comptroller, oracle, borrowerAddress, provider) {
    const positions = [];
    
    try {
        const markets = await comptroller.getAllMarkets();
        
        for (const marketAddress of markets) {
            const vToken = new ethers.Contract(marketAddress, VTOKEN_ABI, provider);
            
            try {
                // Use stored balance (view function, no state change)
                const borrowBalance = await vToken.borrowBalanceStored(borrowerAddress);
                
                if (borrowBalance > 0n) {
                    const [underlying, symbol, price] = await Promise.all([
                        vToken.underlying().catch(() => ethers.ZeroAddress), // vBNB doesn't have underlying
                        vToken.symbol(),
                        oracle.getUnderlyingPrice(marketAddress)
                    ]);
                    
                    // Calculate USD value
                    const valueUSD = (borrowBalance * price) / ethers.parseEther("1");
                    
                    positions.push({
                        vToken: marketAddress,
                        vTokenSymbol: symbol,
                        underlying: underlying === ethers.ZeroAddress ? "BNB" : underlying,
                        borrowBalance,
                        priceUSD: price,
                        valueUSD
                    });
                }
            } catch (error) {
                // Skip this market
                continue;
            }
        }
        
        // Sort by value (largest first)
        positions.sort((a, b) => {
            if (a.valueUSD > b.valueUSD) return -1;
            if (a.valueUSD < b.valueUSD) return 1;
            return 0;
        });
        
        return positions;
    } catch (error) {
        console.error(`Error getting borrow positions: ${error.message}`);
        return [];
    }
}

/**
 * Get all collateral positions for an address
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @param {Object} oracle - Venus PriceOracle contract
 * @param {string} borrowerAddress - Address to check
 * @param {Object} provider - Ethers provider
 * @returns {Array} Array of collateral positions
 */
async function getAllCollateralPositions(comptroller, oracle, borrowerAddress, provider) {
    const positions = [];
    
    try {
        const markets = await comptroller.getAllMarkets();
        
        for (const marketAddress of markets) {
            const vToken = new ethers.Contract(marketAddress, VTOKEN_ABI, provider);
            
            try {
                // Check vToken balance first (cheaper)
                const vTokenBalance = await vToken.balanceOf(borrowerAddress);
                
                if (vTokenBalance > 0n) {
                    // Get exchange rate and calculate underlying balance
                    const exchangeRate = await vToken.exchangeRateStored();
                    const underlyingBalance = (vTokenBalance * exchangeRate) / ethers.parseEther("1");
                    
                    if (underlyingBalance > 0n) {
                        const [underlying, symbol, price] = await Promise.all([
                            vToken.underlying().catch(() => ethers.ZeroAddress),
                            vToken.symbol(),
                            oracle.getUnderlyingPrice(marketAddress)
                        ]);
                        
                        // Calculate USD value
                        const valueUSD = (underlyingBalance * price) / ethers.parseEther("1");
                        
                        positions.push({
                            vToken: marketAddress,
                            vTokenSymbol: symbol,
                            underlying: underlying === ethers.ZeroAddress ? "BNB" : underlying,
                            vTokenBalance,
                            underlyingBalance,
                            priceUSD: price,
                            valueUSD
                        });
                    }
                }
            } catch (error) {
                // Skip this market
                continue;
            }
        }
        
        // Sort by value (largest first)
        positions.sort((a, b) => {
            if (a.valueUSD > b.valueUSD) return -1;
            if (a.valueUSD < b.valueUSD) return 1;
            return 0;
        });
        
        return positions;
    } catch (error) {
        console.error(`Error getting collateral positions: ${error.message}`);
        return [];
    }
}

/**
 * Get oracle price for a vToken
 * 
 * @param {Object} oracle - Venus PriceOracle contract
 * @param {string} vTokenAddress - vToken address
 * @returns {BigInt} Price in USD (18 decimals)
 */
async function getOraclePrice(oracle, vTokenAddress) {
    try {
        const price = await oracle.getUnderlyingPrice(vTokenAddress);
        return price;
    } catch (error) {
        console.error(`Error getting oracle price: ${error.message}`);
        return 0n;
    }
}

/**
 * Get liquidation parameters from Venus
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @returns {Object} Liquidation parameters
 */
async function getLiquidationParameters(comptroller) {
    try {
        const [liquidationIncentive, closeFactor] = await Promise.all([
            comptroller.liquidationIncentiveMantissa(),
            comptroller.closeFactorMantissa()
        ]);
        
        return {
            liquidationIncentive,  // e.g., 1.08e18 = 8% bonus
            closeFactor,           // e.g., 0.5e18 = 50% max liquidation
            incentivePercent: ((Number(liquidationIncentive) / 1e18) - 1) * 100,
            closeFactorPercent: (Number(closeFactor) / 1e18) * 100
        };
    } catch (error) {
        console.error(`Error getting liquidation parameters: ${error.message}`);
        return null;
    }
}

/**
 * Get token metadata (symbol, decimals)
 * 
 * @param {string} tokenAddress - Token address
 * @param {Object} provider - Ethers provider
 * @returns {Object} Token info
 */
async function getTokenInfo(tokenAddress, provider) {
    try {
        if (tokenAddress === ethers.ZeroAddress || tokenAddress === "BNB") {
            return {
                address: ethers.ZeroAddress,
                symbol: "BNB",
                decimals: 18
            };
        }
        
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const [symbol, decimals] = await Promise.all([
            token.symbol(),
            token.decimals()
        ]);
        
        return {
            address: tokenAddress,
            symbol,
            decimals: Number(decimals)
        };
    } catch (error) {
        console.error(`Error getting token info: ${error.message}`);
        return null;
    }
}

/**
 * Check if a market is listed and active
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @param {string} vTokenAddress - vToken address
 * @returns {boolean} True if market is active
 */
async function isMarketActive(comptroller, vTokenAddress) {
    try {
        const [isListed, , ] = await comptroller.markets(vTokenAddress);
        return isListed;
    } catch (error) {
        console.error(`Error checking market status: ${error.message}`);
        return false;
    }
}

/**
 * Find best liquidation opportunity
 * Determines which debt to repay and which collateral to seize
 * 
 * @param {Array} borrowPositions - All borrow positions
 * @param {Array} collateralPositions - All collateral positions
 * @param {Object} comptroller - Venus Comptroller contract
 * @returns {Object|null} Best liquidation pair or null
 */
async function findBestLiquidationPair(borrowPositions, collateralPositions, comptroller) {
    if (borrowPositions.length === 0 || collateralPositions.length === 0) {
        return null;
    }
    
    // Strategy: Liquidate largest debt with most liquid collateral
    const largestDebt = borrowPositions[0]; // Already sorted by value
    
    // Find most liquid collateral (highest value)
    const bestCollateral = collateralPositions[0]; // Already sorted by value
    
    // Get liquidation parameters
    const params = await getLiquidationParameters(comptroller);
    if (!params) return null;
    
    // Calculate max repay (typically 50% of debt)
    const maxRepay = (largestDebt.borrowBalance * params.closeFactor) / ethers.parseEther("1");
    
    return {
        debtPosition: largestDebt,
        collateralPosition: bestCollateral,
        maxRepayAmount: maxRepay,
        liquidationIncentive: params.liquidationIncentive,
        closeFactorPercent: params.closeFactorPercent
    };
}

/**
 * Format Venus position for display
 * 
 * @param {Object} position - Position object
 * @param {string} type - 'borrow' or 'collateral'
 * @returns {string} Formatted string
 */
function formatPosition(position, type = 'borrow') {
    if (type === 'borrow') {
        return `
        vToken: ${position.vTokenSymbol}
        Borrowed: ${ethers.formatEther(position.borrowBalance)}
        Value: $${ethers.formatEther(position.valueUSD)}
        `;
    } else {
        return `
        vToken: ${position.vTokenSymbol}
        Balance: ${ethers.formatEther(position.underlyingBalance)}
        Value: $${ethers.formatEther(position.valueUSD)}
        `;
    }
}

/**
 * Monitor Venus events for new liquidation opportunities
 * 
 * @param {Object} comptroller - Venus Comptroller contract
 * @param {Function} callback - Called when new borrow detected
 */
function subscribeToVenusEvents(comptroller, callback) {
    // Market events
    comptroller.on("MarketEntered", (vToken, account) => {
        console.log(`Market entered: ${account} → ${vToken}`);
        callback({ type: 'market_entered', vToken, account });
    });
    
    // This requires vToken contract listeners
    // You'd need to subscribe to each vToken individually
}

module.exports = {
    getVenusAccountData,
    getAllBorrowPositions,
    getAllCollateralPositions,
    getOraclePrice,
    getLiquidationParameters,
    getTokenInfo,
    isMarketActive,
    findBestLiquidationPair,
    formatPosition,
    subscribeToVenusEvents,
    
    // Export ABIs for use in main bot
    COMPTROLLER_ABI,
    VTOKEN_ABI,
    ORACLE_ABI,
    ERC20_ABI
};
