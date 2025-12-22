// Bot Wrapper with Dashboard Integration
// This file wraps the existing bot and provides methods for the dashboard

require("dotenv").config();
const ethers = require("ethers");
const TelegramBot = require('node-telegram-bot-api');
const DashboardServer = require('./server');

// Import helpers
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

// Configuration validation
const REQUIRED_ENV = [
    'PRIVATE_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'LIQUIDATION_CONTRACT_ADDRESS'
];

const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
    console.warn(`⚠️  Missing environment variables: ${missingEnv.join(', ')}`);
    console.warn(`⚠️  Bot functionality will be limited. Dashboard will still work.\n`);
}

class BotWrapper {
    constructor() {
        this.isRunning = true;
        this.liquidationCount = 0;
        this.totalProfit = 0n;
        this.monitoredAddresses = new Set();
        this.cachedBorrowers = [];
        this.lastBorrowerFetchTs = 0;
        this.lastBorrowerBlock = 0;
        this.recentLiquidations = [];
        this.currentOpportunities = [];
        this.currentBlock = 0;
        this.walletBalance = 0n;
        
        // Initialize only if we have required env vars
        if (missingEnv.length === 0) {
            this.initializeBot();
        } else {
            console.log('📊 Running in dashboard-only mode\n');
        }

        // Initialize dashboard server
        this.dashboardServer = new DashboardServer(this);
    }

    initializeBot() {
        // BSC RPC and Provider
        const BSC_RPC = process.env.BSC_RPC_QUICKNODE || "https://bsc-dataseed.binance.org/";
        this.provider = new ethers.JsonRpcProvider(BSC_RPC);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);

        // Venus Protocol Addresses
        this.VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";
        this.VENUS_ORACLE = "0xd8B6dA2bfEC71D684D3E2a2FC9492dDad5C3787F";

        // Venus vTokens
        this.VENUS_MARKETS = {
            vBNB: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
            vUSDT: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
            vBUSD: "0x95c78222B3D6e262426483D42CfA53685A67Ab9D",
            vBTC: "0x882C173bC7Ff3b7786CA16dfeD3DFFfb9Ee7847B",
            vETH: "0xf508fCD89b8bd15579dc79A6827cB4686A3592c8",
            vUSDC: "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8"
        };

        // Liquidation contract
        this.LIQUIDATION_CONTRACT = process.env.LIQUIDATION_CONTRACT_ADDRESS;

        // Bot parameters
        this.MIN_PROFIT_THRESHOLD = ethers.parseEther("0.01");
        this.MAX_LIQUIDATION_SIZE = ethers.parseEther("100");
        this.POLLING_INTERVAL = 10000;
        this.BORROWER_REFRESH_INTERVAL_MS = 60000;
        this.MAX_BORROWERS_PER_SCAN = 25;
        this.DEFAULT_MIN_OUT_BPS = 100;
        this.DEFAULT_GAS_LIMIT = 800000n;
        this.DEFAULT_SWAP_SLIPPAGE = 0.01;
        this.ONE = ethers.parseEther("1");
        this.GAS_ESTIMATE_BUFFER_PERCENT = parseInt(process.env.GAS_ESTIMATE_BUFFER_PERCENT || "20");

        // Initialize contracts
        const COMPTROLLER_ABI = [
            "function getAccountLiquidity(address account) external view returns (uint, uint, uint)",
            "function getAllMarkets() external view returns (address[])",
            "function liquidationIncentiveMantissa() external view returns (uint)",
            "function markets(address) external view returns (bool, uint, bool)"
        ];

        const ORACLE_ABI = [
            "function getUnderlyingPrice(address vToken) external view returns (uint)"
        ];

        const LIQUIDATION_ABI = [
            "function executeLiquidation(address borrower, address debtToken, address collateralToken, address vDebtToken, address vCollateralToken, uint256 repayAmount, uint24 swapFee, uint256 minOutBps) external"
        ];

        this.comptroller = new ethers.Contract(this.VENUS_COMPTROLLER, COMPTROLLER_ABI, this.provider);
        this.oracle = new ethers.Contract(this.VENUS_ORACLE, ORACLE_ABI, this.provider);
        this.liquidationContract = new ethers.Contract(this.LIQUIDATION_CONTRACT, LIQUIDATION_ABI, this.wallet);

        // Telegram bot
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
        this.setupTelegramCommands();
    }

    setupTelegramCommands() {
        this.bot.onText(/\/start/, () => {
            this.start();
            this.sendMessage("✅ Liquidation Bot *STARTED*");
        });

        this.bot.onText(/\/stop/, () => {
            this.stop();
            this.sendMessage("⏸️ Liquidation Bot *STOPPED*");
        });

        this.bot.onText(/\/status/, async () => {
            if (!this.provider) return;
            const balance = await this.provider.getBalance(this.wallet.address);
            const blockNumber = await this.provider.getBlockNumber();
            
            this.sendMessage(
                `📊 *Bot Status*\n\n` +
                `Network: BSC Mainnet\n` +
                `Protocol: Venus\n` +
                `Status: ${this.isRunning ? '🟢 Running' : '🔴 Stopped'}\n` +
                `Block: ${blockNumber}\n` +
                `Liquidations: ${this.liquidationCount}\n` +
                `Total Profit: ${ethers.formatEther(this.totalProfit)} BNB\n` +
                `Balance: ${ethers.formatEther(balance)} BNB`
            );
        });
    }

    sendMessage(text) {
        if (this.bot && process.env.TELEGRAM_CHAT_ID) {
            this.bot.sendMessage(process.env.TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' })
                .catch(e => console.error('Telegram error:', e.message));
        }
    }

    start() {
        this.isRunning = true;
        console.log('✅ Bot started');
    }

    stop() {
        this.isRunning = false;
        console.log('⏸️  Bot stopped');
    }

    // Dashboard API methods
    getTotalProfit() {
        return ethers.formatEther(this.totalProfit);
    }

    getLiquidationCount() {
        return this.liquidationCount;
    }

    getWalletBalance() {
        return ethers.formatEther(this.walletBalance);
    }

    getActiveBorrowers() {
        return this.cachedBorrowers.length;
    }

    getCurrentBlock() {
        return this.currentBlock;
    }

    getWalletAddress() {
        return this.wallet ? this.wallet.address : 'N/A';
    }

    getMinProfit() {
        return this.MIN_PROFIT_THRESHOLD ? ethers.formatEther(this.MIN_PROFIT_THRESHOLD) : '0.01';
    }

    getPollingInterval() {
        return this.POLLING_INTERVAL ? this.POLLING_INTERVAL / 1000 : 10;
    }

    getRecentLiquidations() {
        return this.recentLiquidations.slice(0, 20);
    }

    getCurrentOpportunities() {
        return this.currentOpportunities;
    }

    async updateWalletBalance() {
        if (this.provider && this.wallet) {
            try {
                this.walletBalance = await this.provider.getBalance(this.wallet.address);
                this.dashboardServer.emitStatsUpdate({
                    walletBalance: ethers.formatEther(this.walletBalance)
                });
            } catch (error) {
                console.error('Error updating wallet balance:', error.message);
            }
        }
    }

    async updateCurrentBlock() {
        if (this.provider) {
            try {
                this.currentBlock = await this.provider.getBlockNumber();
            } catch (error) {
                console.error('Error updating block:', error.message);
            }
        }
    }

    /**
     * Estimate gas for liquidation with configurable buffer
     * Returns dynamic gas limit or falls back to default
     */
    async estimateGasForLiquidation(opportunity) {
        try {
            const swapFee = 2500; // 0.25% tier
            const gasEstimate = await this.liquidationContract.executeLiquidation.estimateGas(
                opportunity.borrower,
                opportunity.debtToken,
                opportunity.collateralToken,
                opportunity.vDebtToken,
                opportunity.vCollateralToken,
                opportunity.repayAmount,
                swapFee,
                opportunity.minOutBps
            );
            
            // Add configurable buffer to gas estimate
            const bufferMultiplier = 100n + BigInt(this.GAS_ESTIMATE_BUFFER_PERCENT);
            const gasWithBuffer = (gasEstimate * bufferMultiplier) / 100n;
            console.log(`   Gas Estimate: ${gasEstimate.toString()} (with ${this.GAS_ESTIMATE_BUFFER_PERCENT}% buffer: ${gasWithBuffer.toString()})`);
            return gasWithBuffer;
        } catch (error) {
            console.log(`   Gas estimation failed, using default: ${error.message}`);
            return this.DEFAULT_GAS_LIMIT;
        }
    }

    async runMonitoringCycle() {
        if (!this.isRunning || !this.provider) {
            return;
        }

        console.log('\n🔍 Scanning for liquidation opportunities...');
        
        // Update block and balance
        await this.updateCurrentBlock();
        await this.updateWalletBalance();

        // TODO: Integrate actual liquidation monitoring logic from bscLiquidationBot.js
        // This is a simplified version for dashboard demonstration
        // In production, replace this with actual Venus Protocol monitoring:
        // 1. Call getActiveBorrowers() to get list of borrowers
        // 2. For each borrower, call checkLiquidationOpportunity()
        // 3. If profitable opportunity found, call executeLiquidation()
        
        // DEMO MODE: The following code is for demonstration only
        // Remove or disable this section when integrating real bot logic
        if (process.env.ENABLE_DEMO_MODE === 'true') {
            // Simulate finding an opportunity (5% chance per cycle)
            if (Math.random() > 0.95) {
                const mockOpportunity = {
                    borrower: '0x' + Math.random().toString(16).substring(2, 42),
                    expectedProfit: (Math.random() * 0.1).toFixed(4) + ' BNB',
                    shortfall: (Math.random() * 100).toFixed(2) + ' USD',
                    repayAmount: (Math.random() * 10).toFixed(4) + ' tokens',
                    timestamp: Date.now()
                };
                
                this.currentOpportunities.unshift(mockOpportunity);
                if (this.currentOpportunities.length > 5) {
                    this.currentOpportunities.pop();
                }
                
                this.dashboardServer.emitLiquidationFound(mockOpportunity);
                console.log('💡 Demo opportunity found:', mockOpportunity.borrower);
            }
        }
    }

    async startDashboard(port = 3000) {
        await this.dashboardServer.start(port);
    }

    async run() {
        console.log(`\n${"=".repeat(70)}`);
        console.log(`   BSC VENUS LIQUIDATION BOT WITH DASHBOARD`);
        console.log(`   Flash Loans: PancakeSwap V3 (0% FEES!)`);
        console.log(`${"=".repeat(70)}\n`);
        
        if (this.wallet) {
            console.log(`💼 Wallet: ${this.wallet.address}`);
            console.log(`🏦 Venus Comptroller: ${this.VENUS_COMPTROLLER}`);
            console.log(`💰 Min Profit: ${ethers.formatEther(this.MIN_PROFIT_THRESHOLD)} BNB`);
            console.log(`⚙️  Polling Interval: ${this.POLLING_INTERVAL}ms`);
        }

        // Start dashboard server
        const dashboardPort = process.env.DASHBOARD_PORT || 3000;
        await this.startDashboard(dashboardPort);

        if (this.wallet) {
            this.sendMessage(
                `🤖 *Liquidation Bot Started*\n\n` +
                `Protocol: Venus (BSC)\n` +
                `Flash Loans: FREE (0%)\n` +
                `Min Profit: ${ethers.formatEther(this.MIN_PROFIT_THRESHOLD)} BNB\n` +
                `Dashboard: http://localhost:${dashboardPort}\n` +
                `Status: 🟢 Active`
            );
        }

        // Main monitoring loop
        while (true) {
            if (this.isRunning) {
                await this.runMonitoringCycle();
            }
            
            await new Promise(resolve => setTimeout(resolve, this.POLLING_INTERVAL));
        }
    }
}

// Start the bot with dashboard
async function main() {
    const botWrapper = new BotWrapper();
    await botWrapper.run();
}

main().catch(error => {
    console.error("💥 Fatal error:", error);
    process.exit(1);
});
