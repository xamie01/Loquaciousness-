// bscLiquidationBot.js
// PRODUCTION BSC LIQUIDATION BOT FOR VENUS PROTOCOL

require("dotenv").config();
const ethers = require("ethers");
const TelegramBot = require('node-telegram-bot-api');

// Helper utilities for Venus liquidation math
const {
    getVenusAccountData,
    getAllBorrowPositions,
    getAllCollateralPositions,
    getLiquidationParameters,
    findBestLiquidationPair,
    verifyLiquidatable
} = require('./helpers/venusHelpers');

const {
    calculateCollateralSeized,
    calculateLiquidationProfit
} = require('./helpers/liquidationCalculator');

// New safety and monitoring helpers
const CircuitBreaker = require('./helpers/circuitBreaker');
const EventMonitor = require('./helpers/eventMonitor');

// ============================================
// CONFIGURATION
// ============================================

const REQUIRED_ENV = [
    'PRIVATE_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'LIQUIDATION_CONTRACT_ADDRESS'
];

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
    throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const BSC_RPC = process.env.BSC_RPC_QUICKNODE || "https://bsc-dataseed.binance.org/";
const provider = new ethers.JsonRpcProvider(BSC_RPC);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Venus Protocol Addresses (BSC Mainnet)
const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";
const VENUS_ORACLE = "0xd8B6dA2bfEC71D684D3E2a2FC9492dDad5C3787F";

// Venus vTokens (most liquid markets)
const VENUS_MARKETS = {
    vBNB: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",    // Wrapped BNB
    vUSDT: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",   // USDT
    vBUSD: "0x95c78222B3D6e262426483D42CfA53685A67Ab9D",   // BUSD
    vBTC: "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B",    // BTCB
    vETH: "0xf508fCD89b8bd15579dc79A6827cB4686A3592c8",    // ETH
    vUSDC: "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8"    // USDC
};

// Your deployed liquidation contract
const LIQUIDATION_CONTRACT = process.env.LIQUIDATION_CONTRACT_ADDRESS;

// Bot parameters
const MIN_PROFIT_THRESHOLD = ethers.parseEther("0.01"); // 0.01 BNB min profit
const MAX_LIQUIDATION_SIZE = ethers.parseEther("100");  // Cap liquidation size (in BNB notional)
const HEALTH_FACTOR_THRESHOLD = ethers.parseEther("1.0"); // < 1.0 = liquidatable
const POLLING_INTERVAL = 10000; // Check every 10 seconds
const BORROWER_REFRESH_INTERVAL_MS = 60000; // Refresh borrower list every 60s
const MAX_BORROWERS_PER_SCAN = 25; // Limit per cycle to reduce RPC load

const ONE = ethers.parseEther("1");
const DEFAULT_SWAP_SLIPPAGE = 0.01; // 1%
const DEFAULT_GAS_LIMIT = 800000n;
const DEFAULT_MIN_OUT_BPS = 100; // 1% buffer over repay to protect profit

// ============================================
// CONTRACT ABIs
// ============================================

const COMPTROLLER_ABI = [
    "function getAccountLiquidity(address account) external view returns (uint, uint, uint)",
    "function getAllMarkets() external view returns (address[])",
    "function liquidationIncentiveMantissa() external view returns (uint)",
    "function markets(address) external view returns (bool, uint, bool)"
];

const VTOKEN_ABI = [
    "function borrowBalanceCurrent(address account) external returns (uint)",
    "function balanceOfUnderlying(address owner) external returns (uint)",
    "function exchangeRateCurrent() external returns (uint)",
    "function underlying() external view returns (address)",
    "function liquidateBorrow(address borrower, uint repayAmount, address vTokenCollateral) external returns (uint)"
];

const ORACLE_ABI = [
    "function getUnderlyingPrice(address vToken) external view returns (uint)"
];

const LIQUIDATION_ABI = [
    "function executeLiquidation(address borrower, address debtToken, address collateralToken, address vDebtToken, address vCollateralToken, uint256 repayAmount, uint24 swapFee) external"
];

// ============================================
// INITIALIZE CONTRACTS
// ============================================

const comptroller = new ethers.Contract(VENUS_COMPTROLLER, COMPTROLLER_ABI, provider);
const oracle = new ethers.Contract(VENUS_ORACLE, ORACLE_ABI, provider);
const liquidationContract = new ethers.Contract(LIQUIDATION_CONTRACT, LIQUIDATION_ABI, wallet);

// Initialize safety and monitoring systems
const circuitBreaker = new CircuitBreaker(oracle, VENUS_MARKETS);
const eventMonitor = new EventMonitor(provider, VENUS_MARKETS);

// ============================================
// TELEGRAM BOT
// ============================================

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const sendMessage = (text) => {
    bot.sendMessage(process.env.TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' })
        .catch(e => console.error('Telegram error:', e.message));
};

// ============================================
// STATE TRACKING
// ============================================

let isRunning = true;
let liquidationCount = 0;
let totalProfit = 0n;
let monitoredAddresses = new Set();
let cachedBorrowers = [];
let lastBorrowerFetchTs = 0;
let lastBorrowerBlock = 0;
let useEventMonitoring = process.env.USE_EVENT_MONITORING === 'true';

// ============================================
// UTILITY HELPERS
// ============================================

async function getBnbPriceUSD() {
    // Venus oracle price for vBNB (18 decimals, USD)
    return oracle.getUnderlyingPrice(VENUS_MARKETS.vBNB);
}

function convertAmountToBNB(amount, tokenPriceUSD, bnbPriceUSD) {
    if (!tokenPriceUSD || !bnbPriceUSD) return 0n;
    const valueUSD = (amount * tokenPriceUSD) / ONE;
    return (valueUSD * ONE) / bnbPriceUSD;
}

function convertBNBToAmount(bnbAmount, tokenPriceUSD, bnbPriceUSD) {
    if (!tokenPriceUSD || !bnbPriceUSD) return bnbAmount;
    const valueUSD = (bnbAmount * bnbPriceUSD) / ONE;
    return (valueUSD * ONE) / tokenPriceUSD;
}

async function getSafeGasPrice() {
    const fee = await provider.getFeeData();
    return fee.gasPrice ? fee.gasPrice : ethers.parseUnits("3", "gwei");
}

/**
 * Estimate gas for liquidation with 20% buffer
 * Returns dynamic gas limit or falls back to default
 */
async function estimateGasForLiquidation(opportunity) {
    try {
        const swapFee = 2500; // 0.25% tier
        const gasEstimate = await liquidationContract.executeLiquidation.estimateGas(
            opportunity.borrower,
            opportunity.debtToken,
            opportunity.collateralToken,
            opportunity.vDebtToken,
            opportunity.vCollateralToken,
            opportunity.repayAmount,
            swapFee,
            opportunity.minOutBps
        );
        
        // Add 20% buffer to gas estimate
        const gasWithBuffer = (gasEstimate * 120n) / 100n;
        console.log(`   Gas Estimate: ${gasEstimate.toString()} (with 20% buffer: ${gasWithBuffer.toString()})`);
        return gasWithBuffer;
    } catch (error) {
        console.log(`   Gas estimation failed, using default: ${error.message}`);
        return DEFAULT_GAS_LIMIT;
    }
}

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Get all borrowers from Venus Protocol
 * Now supports both event monitoring and legacy polling
 */
async function getActiveBorrowers() {
    // If event monitoring is enabled and has borrowers, use those
    if (useEventMonitoring && eventMonitor.getCount() > 0) {
        const borrowers = eventMonitor.getActiveBorrowers();
        console.log(`   Using ${borrowers.length} borrowers from event monitor`);
        return borrowers.slice(0, MAX_BORROWERS_PER_SCAN);
    }

    // Legacy method: query historical events
    const now = Date.now();
    if (now - lastBorrowerFetchTs < BORROWER_REFRESH_INTERVAL_MS && cachedBorrowers.length) {
        return cachedBorrowers;
    }

    const borrowers = new Set();
    const markets = Object.values(VENUS_MARKETS); // Limit to most liquid markets to reduce calls

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = lastBorrowerBlock ? lastBorrowerBlock + 1 : Math.max(currentBlock - 500, 0);
    lastBorrowerBlock = currentBlock;
    
    for (const marketAddress of markets) {
        const vToken = new ethers.Contract(marketAddress, VTOKEN_ABI, provider);
        
        try {
            const filter = vToken.filters.Borrow();
            const events = await vToken.queryFilter(filter, fromBlock, currentBlock);
            
            events.forEach(event => {
                borrowers.add(event.args.borrower);
            });
        } catch (error) {
            console.log(`Error fetching events for ${marketAddress}: ${error.message}`);
        }
    }
    
    cachedBorrowers = Array.from(borrowers).slice(0, MAX_BORROWERS_PER_SCAN);
    lastBorrowerFetchTs = now;
    return cachedBorrowers;
}

/**
 * Check if a position is liquidatable using Venus helpers
 */
async function checkLiquidationOpportunity(borrowerAddress) {
    try {
        const account = await getVenusAccountData(comptroller, borrowerAddress);
        if (!account || !account.isLiquidatable) {
            return null;
        }

        const [borrowPositions, collateralPositions, params, bnbPriceUSD, gasPrice] = await Promise.all([
            getAllBorrowPositions(comptroller, oracle, borrowerAddress, provider),
            getAllCollateralPositions(comptroller, oracle, borrowerAddress, provider),
            getLiquidationParameters(comptroller),
            getBnbPriceUSD(),
            getSafeGasPrice()
        ]);

        if (!borrowPositions.length || !collateralPositions.length || !params) {
            return null;
        }

        const pair = await findBestLiquidationPair(borrowPositions, collateralPositions, comptroller);
        if (!pair) {
            return null;
        }

        // Respect close factor and our own size cap
        let repayAmount = pair.maxRepayAmount;

        const repayValueBNB = convertAmountToBNB(repayAmount, pair.debtPosition.priceUSD, bnbPriceUSD);
        if (repayValueBNB > MAX_LIQUIDATION_SIZE) {
            repayAmount = convertBNBToAmount(MAX_LIQUIDATION_SIZE, pair.debtPosition.priceUSD, bnbPriceUSD);
        }

        // Expected collateral seized with liquidation incentive
        const collateralReceived = calculateCollateralSeized(
            repayAmount,
            pair.debtPosition.priceUSD,
            pair.collateralPosition.priceUSD,
            pair.liquidationIncentive
        );

        // Convert collateral to debt token using oracle-derived rate
        const collateralToDebtRate = (pair.collateralPosition.priceUSD * ONE) / pair.debtPosition.priceUSD;

        const profit = calculateLiquidationProfit(
            repayAmount,
            collateralReceived,
            collateralToDebtRate,
            gasPrice,
            DEFAULT_GAS_LIMIT,
            DEFAULT_SWAP_SLIPPAGE
        );

        const profitBNB = convertAmountToBNB(profit.netProfit, pair.debtPosition.priceUSD, bnbPriceUSD);

        if (!profit.isProfitable || profitBNB < MIN_PROFIT_THRESHOLD) {
            return null;
        }

        return {
            borrower: borrowerAddress,
            debtToken: pair.debtPosition.underlying === 'BNB' ? ethers.ZeroAddress : pair.debtPosition.underlying,
            collateralToken: pair.collateralPosition.underlying === 'BNB' ? ethers.ZeroAddress : pair.collateralPosition.underlying,
            vDebtToken: pair.debtPosition.vToken,
            vCollateralToken: pair.collateralPosition.vToken,
            repayAmount,
            expectedProfit: profitBNB,
            expectedProfitBreakdown: profit.breakdown,
            gasPrice,
            shortfall: account.shortfall,
            minOutBps: DEFAULT_MIN_OUT_BPS
        };
        
    } catch (error) {
        console.error(`Error checking ${borrowerAddress}: ${error.message}`);
        return null;
    }
}

/**
 * Execute liquidation
 */
async function executeLiquidation(opportunity) {
    try {
        console.log(`\n⚡ EXECUTING LIQUIDATION`);
        console.log(`   Borrower: ${opportunity.borrower}`);
        console.log(`   Debt Repay: ${ethers.formatEther(opportunity.repayAmount)} tokens`);
        console.log(`   Expected Profit: ${ethers.formatEther(opportunity.expectedProfit)} BNB\n`);
        
        const stillValid = await verifyLiquidatable(comptroller, opportunity.borrower);
        if (!stillValid) {
            console.log('Position no longer liquidatable, skipping.');
            return false;
        }

        // Determine swap fee (use 0.25% tier - most liquid)
        const swapFee = 2500;
        
        // Use dynamic gas estimation with fallback
        const gasLimit = await estimateGasForLiquidation(opportunity);
        
        // Execute liquidation via our contract
        const tx = await liquidationContract.executeLiquidation(
            opportunity.borrower,
            opportunity.debtToken,
            opportunity.collateralToken,
            opportunity.vDebtToken,
            opportunity.vCollateralToken,
            opportunity.repayAmount,
            swapFee,
            opportunity.minOutBps,
            {
                gasLimit: gasLimit,
                gasPrice: opportunity.gasPrice
            }
        );
        
        console.log(`   📤 TX sent: ${tx.hash}`);
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            liquidationCount++;
            totalProfit += opportunity.expectedProfit;
            
            console.log(`\n✅ LIQUIDATION SUCCESSFUL!`);
            console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);
            console.log(`   Total Liquidations: ${liquidationCount}`);
            console.log(`   Total Profit: ${ethers.formatEther(totalProfit)} BNB`);
            
            sendMessage(
                `🎯 *Liquidation Success!*\n\n` +
                `Borrower: \`${opportunity.borrower.substring(0, 10)}...\`\n` +
                `Profit: *${ethers.formatEther(opportunity.expectedProfit)} BNB*\n` +
                `Total: ${ethers.formatEther(totalProfit)} BNB\n` +
                `Count: ${liquidationCount}\n` +
                `[View TX](https://bscscan.com/tx/${receipt.hash})`
            );
            
            return true;
        }
        
    } catch (error) {
        const errorMsg = error.reason || error.message || 'Unknown error';
        console.error(`❌ Liquidation failed: ${errorMsg}`);
        
        sendMessage(`❌ *Liquidation Failed*\n\nReason: ${errorMsg.substring(0, 100)}`);
        return false;
    }
}

/**
 * Main monitoring loop
 */
async function monitorPositions() {
    console.log(`\n🔍 Scanning for liquidation opportunities...`);
    
    // Check circuit breaker before proceeding
    if (!circuitBreaker.isOperational()) {
        console.log(`⚠️  Circuit breaker tripped: ${circuitBreaker.getStatus().tripReason}`);
        console.log(`   Skipping monitoring cycle for safety`);
        return;
    }

    // Perform price safety check
    const pricesOk = await circuitBreaker.checkPrices();
    if (!pricesOk) {
        sendMessage(`🚨 *Circuit Breaker Tripped*\n\n${circuitBreaker.getStatus().tripReason}\n\nBot operations halted for safety.`);
        return;
    }
    
    try {
        // Get list of borrowers to monitor
        const borrowers = await getActiveBorrowers();
        
        console.log(`   Found ${borrowers.length} active borrowers`);
        
        // Check each borrower
        for (const borrower of borrowers) {
            if (!isRunning) break;
            
            const opportunity = await checkLiquidationOpportunity(borrower);
            
            if (opportunity) {
                console.log(`\n💡 LIQUIDATION OPPORTUNITY FOUND!`);
                console.log(`   Borrower: ${opportunity.borrower}`);
                console.log(`   Shortfall: ${ethers.formatEther(opportunity.shortfall)} USD`);
                console.log(`   Expected Profit: ${ethers.formatEther(opportunity.expectedProfit)} BNB`);
                
                // Execute liquidation
                const success = await executeLiquidation(opportunity);
                
                if (success) {
                    // Wait a bit after successful liquidation
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
        
    } catch (error) {
        console.error(`❌ Monitoring error: ${error.message}`);
    }
}

// ============================================
// TELEGRAM COMMANDS
// ============================================

bot.onText(/\/start/, () => {
    isRunning = true;
    sendMessage("✅ Liquidation Bot *STARTED*");
});

bot.onText(/\/stop/, () => {
    isRunning = false;
    sendMessage("⏸️ Liquidation Bot *STOPPED*");
});

bot.onText(/\/status/, async () => {
    const balance = await provider.getBalance(wallet.address);
    const blockNumber = await provider.getBlockNumber();
    const cbStatus = circuitBreaker.getStatus();
    
    sendMessage(
        `📊 *Bot Status*\n\n` +
        `Network: BSC Mainnet\n` +
        `Protocol: Venus\n` +
        `Status: ${isRunning ? '🟢 Running' : '🔴 Stopped'}\n` +
        `Block: ${blockNumber}\n` +
        `Liquidations: ${liquidationCount}\n` +
        `Total Profit: ${ethers.formatEther(totalProfit)} BNB\n` +
        `Balance: ${ethers.formatEther(balance)} BNB\n` +
        `Circuit Breaker: ${cbStatus.isTripped ? '🔴 Tripped' : '🟢 OK'}\n` +
        `Event Monitor: ${useEventMonitoring ? `🟢 Active (${eventMonitor.getCount()} borrowers)` : '⚪ Disabled'}`
    );
});

bot.onText(/\/reset/, async () => {
    await circuitBreaker.reset();
    sendMessage("🔄 *Circuit Breaker Reset*\n\nPrice monitoring reinitialized. Bot can resume operations.");
});

bot.onText(/\/events/, () => {
    if (!useEventMonitoring) {
        sendMessage("⚠️ *Event monitoring is disabled*\n\nSet USE_EVENT_MONITORING=true in .env to enable.");
        return;
    }
    
    const borrowerCount = eventMonitor.getCount();
    const borrowers = eventMonitor.getActiveBorrowers().slice(0, 5);
    
    let message = `📊 *Event Monitor Status*\n\n` +
        `Total Borrowers: ${borrowerCount}\n` +
        `Listening: ${eventMonitor.isListening ? '🟢 Yes' : '🔴 No'}\n\n`;
    
    if (borrowers.length > 0) {
        message += `Recent Borrowers:\n`;
        borrowers.forEach((addr, i) => {
            message += `${i + 1}. \`${addr.substring(0, 10)}...\`\n`;
        });
    }
    
    sendMessage(message);
});

// ============================================
// MAIN FUNCTION
// ============================================

async function main() {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`   BSC VENUS LIQUIDATION BOT`);
    console.log(`   Flash Loans: PancakeSwap V3 (0% FEES!)`);
    console.log(`${"=".repeat(70)}\n`);
    
    console.log(`💼 Wallet: ${wallet.address}`);
    console.log(`🏦 Venus Comptroller: ${VENUS_COMPTROLLER}`);
    console.log(`💰 Min Profit: ${ethers.formatEther(MIN_PROFIT_THRESHOLD)} BNB`);
    console.log(`⚙️  Polling Interval: ${POLLING_INTERVAL}ms\n`);
    
    // Initialize circuit breaker
    await circuitBreaker.initialize();
    
    // Initialize event monitoring if enabled
    if (useEventMonitoring) {
        console.log('🎯 Event monitoring enabled');
        await eventMonitor.startListening();
        
        // Get historical borrowers to seed the monitor
        const currentBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(currentBlock - 1000, 0);
        await eventMonitor.getHistoricalBorrowers(fromBlock, currentBlock);
    } else {
        console.log('📊 Using legacy event polling (set USE_EVENT_MONITORING=true for real-time monitoring)\n');
    }
    
    sendMessage(
        `🤖 *Liquidation Bot Started*\n\n` +
        `Protocol: Venus (BSC)\n` +
        `Flash Loans: FREE (0%)\n` +
        `Min Profit: ${ethers.formatEther(MIN_PROFIT_THRESHOLD)} BNB\n` +
        `Circuit Breaker: 🟢 Active\n` +
        `Event Monitor: ${useEventMonitoring ? '🟢 Active' : '⚪ Disabled'}\n` +
        `Status: 🟢 Running`
    );
    
    // Main loop
    while (true) {
        if (isRunning) {
            await monitorPositions();
        }
        
        // Wait before next scan
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
    }
}

// ============================================
// CLEANUP ON EXIT
// ============================================

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    if (useEventMonitoring) {
        eventMonitor.stopListening();
    }
    process.exit(0);
});

// ============================================
// START BOT
// ============================================

main().catch(error => {
    console.error("💥 Fatal error:", error);
    sendMessage(`💥 *Fatal Error*\n${error.message}`);
    process.exit(1);
});
