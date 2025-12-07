// helpers/helpers.js
// Updated to support both Uniswap V3 and Camelot V3 (Algebra)

const { ethers } = require("ethers");

/**
 * Get token contracts and metadata
 */
async function getTokenAndContract(token0Address, token1Address, provider) {
    try {
        const erc20Abi = [
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)",
            "function balanceOf(address) view returns (uint256)"
        ];

        const token0Contract = new ethers.Contract(token0Address, erc20Abi, provider);
        const token1Contract = new ethers.Contract(token1Address, erc20Abi, provider);

        const [token0Decimals, token0Symbol, token1Decimals, token1Symbol] = await Promise.all([
            token0Contract.decimals(),
            token0Contract.symbol(),
            token1Contract.decimals(),
            token1Contract.symbol()
        ]);

        return {
            token0: {
                address: token0Address,
                decimals: token0Decimals,
                symbol: token0Symbol,
                contract: token0Contract
            },
            token1: {
                address: token1Address,
                decimals: token1Decimals,
                symbol: token1Symbol,
                contract: token1Contract
            }
        };
    } catch (error) {
        console.error(`Error loading token contracts: ${error.message}`);
        return { token0: null, token1: null };
    }
}

/**
 * Get quote from Quoter V2
 * Compatible with both Uniswap V3 and Camelot (Algebra) quoters
 */
async function getQuote(quoter, tokenIn, tokenOut, amountIn, fee) {
    try {
        // QuoterV2.quoteExactInputSingle parameters
        const params = {
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            fee: fee,
            sqrtPriceLimitX96: 0
        };

        // Call quoteExactInputSingle
        const quote = await quoter.quoteExactInputSingle.staticCall(params);
        
        // Handle different return formats
        // Uniswap V3: returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
        // Algebra: similar structure
        
        let amountOut;
        if (typeof quote === 'object' && quote.amountOut !== undefined) {
            // Named return values
            amountOut = quote.amountOut;
        } else if (Array.isArray(quote)) {
            // Indexed return values
            amountOut = quote[0];
        } else {
            // Direct value
            amountOut = quote;
        }

        return {
            amountOut: amountOut,
            success: true
        };

    } catch (error) {
        // Quote failed - pool might not exist or not enough liquidity
        return {
            amountOut: 0n,
            success: false,
            error: error.message
        };
    }
}

/**
 * Get V3 pool price using Algebra-compatible method
 * Works with both Uniswap V3 and Camelot (Algebra) V3
 */
async function getV3Price(factory, token0, token1) {
    const feeTiers = [500, 3000, 10000]; // 0.05%, 0.3%, 1%
    
    for (const fee of feeTiers) {
        try {
            const poolAddress = await factory.getPool(token0, token1, fee);
            
            if (!poolAddress || poolAddress === ethers.ZeroAddress) {
                continue;
            }

            // Try Algebra's globalState first (used by Camelot)
            try {
                const algebraPoolAbi = [
                    "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)"
                ];
                
                const provider = factory.runner.provider;
                const pool = new ethers.Contract(poolAddress, algebraPoolAbi, provider);
                const state = await pool.globalState();
                
                // Extract sqrtPriceX96 (first value)
                const sqrtPriceX96 = state.price || state[0];
                const price = (Number(sqrtPriceX96) / (2 ** 96)) ** 2;
                
                return {
                    price: price,
                    fee: fee,
                    poolAddress: poolAddress
                };
            } catch (algebraError) {
                // Not Algebra, try standard Uniswap V3
                const uniV3PoolAbi = [
                    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
                ];
                
                const provider = factory.runner.provider;
                const pool = new ethers.Contract(poolAddress, uniV3PoolAbi, provider);
                const slot0 = await pool.slot0();
                
                const sqrtPriceX96 = slot0.sqrtPriceX96 || slot0[0];
                const price = (Number(sqrtPriceX96) / (2 ** 96)) ** 2;
                
                return {
                    price: price,
                    fee: fee,
                    poolAddress: poolAddress
                };
            }
            
        } catch (error) {
            // Pool doesn't exist or error, try next fee tier
            continue;
        }
    }
    
    // No pool found with any fee tier
    return null;
}

/**
 * Check if pool exists on factory
 */
async function poolExists(factory, token0, token1, fee) {
    try {
        const poolAddress = await factory.getPool(token0, token1, fee);
        return poolAddress && poolAddress !== ethers.ZeroAddress;
    } catch (error) {
        return false;
    }
}

/**
 * Get all pools for a token pair across different fee tiers
 */
async function getAllPools(factory, token0, token1) {
    const feeTiers = [500, 3000, 10000];
    const pools = [];
    
    for (const fee of feeTiers) {
        try {
            const poolAddress = await factory.getPool(token0, token1, fee);
            if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                pools.push({
                    fee: fee,
                    address: poolAddress,
                    feePct: fee / 10000
                });
            }
        } catch (error) {
            // Pool doesn't exist
        }
    }
    
    return pools;
}

/**
 * Format token amount for display
 */
function formatTokenAmount(amount, decimals, symbol) {
    const formatted = ethers.formatUnits(amount, decimals);
    return `${formatted} ${symbol}`;
}

/**
 * Calculate price impact
 */
function calculatePriceImpact(amountIn, amountOut, currentPrice) {
    const executionPrice = Number(amountOut) / Number(amountIn);
    const impact = ((executionPrice - currentPrice) / currentPrice) * 100;
    return Math.abs(impact);
}

module.exports = {
    getTokenAndContract,
    getQuote,
    getV3Price,
    poolExists,
    getAllPools,
    formatTokenAmount,
    calculatePriceImpact
};
