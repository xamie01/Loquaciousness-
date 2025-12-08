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

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Get all borrowers from Venus Protocol
 * This is simplified - in production, you'd want to:
 * 1. Subscribe to Venus events (Borrow, Repay, Liquidation)
 * 2. Maintain a database of active borrowers
 * 3. Use The Graph or other indexers
 */
async function getActiveBorrowers() {
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
                gasLimit: DEFAULT_GAS_LIMIT,
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
    
    sendMessage(
        `📊 *Bot Status*\n\n` +
        `Network: BSC Mainnet\n` +
        `Protocol: Venus\n` +
        `Status: ${isRunning ? '🟢 Running' : '🔴 Stopped'}\n` +
        `Block: ${blockNumber}\n` +
        `Liquidations: ${liquidationCount}\n` +
        `Total Profit: ${ethers.formatEther(totalProfit)} BNB\n` +
        `Balance: ${ethers.formatEther(balance)} BNB`
    );
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
    
    sendMessage(
        `🤖 *Liquidation Bot Started*\n\n` +
        `Protocol: Venus (BSC)\n` +
        `Flash Loans: FREE (0%)\n` +
        `Min Profit: ${ethers.formatEther(MIN_PROFIT_THRESHOLD)} BNB\n` +
        `Status: 🟢 Active`
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
// START BOT
// ============================================

main().catch(error => {
    console.error("💥 Fatal error:", error);
    sendMessage(`💥 *Fatal Error*\n${error.message}`);
    process.exit(1);
});
