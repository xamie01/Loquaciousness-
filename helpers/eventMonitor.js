/**
 * helpers/eventMonitor.js
 * 
 * Real-time event monitoring for Venus Protocol
 * Implements improved borrower discovery as recommended in Update.md
 */

const { ethers } = require("ethers");

class EventMonitor {
    constructor(provider, markets) {
        this.provider = provider;
        this.markets = markets;
        this.activeBorrowers = new Set();
        this.eventListeners = [];
        this.isListening = false;
        
        // Venus vToken ABI with events
        this.vTokenABI = [
            "event Borrow(address borrower, uint borrowAmount, uint accountBorrows, uint totalBorrows)",
            "event RepayBorrow(address payer, address borrower, uint repayAmount, uint accountBorrows, uint totalBorrows)",
            "event LiquidateBorrow(address liquidator, address borrower, uint repayAmount, address vTokenCollateral, uint seizeTokens)",
            "function borrowBalanceStored(address account) external view returns (uint)"
        ];
    }

    /**
     * Start listening to real-time events
     */
    async startListening() {
        if (this.isListening) {
            console.log('⚠️  Event monitor already listening');
            return;
        }

        console.log('👂 Starting real-time event monitoring...');
        
        for (const [symbol, address] of Object.entries(this.markets)) {
            try {
                const vToken = new ethers.Contract(address, this.vTokenABI, this.provider);
                
                // Listen for Borrow events
                const borrowListener = vToken.on("Borrow", (borrower, borrowAmount, accountBorrows, totalBorrows, event) => {
                    this.activeBorrowers.add(borrower);
                    console.log(`📊 Borrow event: ${borrower.substring(0, 10)}... borrowed from ${symbol}`);
                });
                
                // Listen for RepayBorrow events
                const repayListener = vToken.on("RepayBorrow", (payer, borrower, repayAmount, accountBorrows, totalBorrows, event) => {
                    if (accountBorrows === 0n) {
                        // Fully repaid, remove from active borrowers
                        this.activeBorrowers.delete(borrower);
                    }
                    console.log(`💰 Repay event: ${borrower.substring(0, 10)}... repaid to ${symbol}`);
                });
                
                // Listen for LiquidateBorrow events
                const liquidateListener = vToken.on("LiquidateBorrow", (liquidator, borrower, repayAmount, vTokenCollateral, seizeTokens, event) => {
                    console.log(`⚡ Liquidation event: ${borrower.substring(0, 10)}... liquidated on ${symbol}`);
                    // Don't remove from set, they might still have other borrows
                });
                
                this.eventListeners.push({ vToken, borrowListener, repayListener, liquidateListener });
                console.log(`   ✅ Monitoring ${symbol}`);
                
            } catch (error) {
                console.error(`   ❌ Error setting up listener for ${symbol}: ${error.message}`);
            }
        }
        
        this.isListening = true;
        console.log(`✅ Event monitoring active for ${Object.keys(this.markets).length} markets\n`);
    }

    /**
     * Stop listening to events
     */
    stopListening() {
        if (!this.isListening) {
            return;
        }

        console.log('🛑 Stopping event monitoring...');
        
        for (const { vToken } of this.eventListeners) {
            vToken.removeAllListeners();
        }
        
        this.eventListeners = [];
        this.isListening = false;
        console.log('✅ Event monitoring stopped\n');
    }

    /**
     * Get historical borrowers from past events
     */
    async getHistoricalBorrowers(fromBlock, toBlock) {
        const borrowers = new Set();
        
        console.log(`📜 Fetching historical events from block ${fromBlock} to ${toBlock}...`);
        
        for (const [symbol, address] of Object.entries(this.markets)) {
            try {
                const vToken = new ethers.Contract(address, this.vTokenABI, this.provider);
                
                // Query Borrow events
                const borrowFilter = vToken.filters.Borrow();
                const events = await vToken.queryFilter(borrowFilter, fromBlock, toBlock);
                
                events.forEach(event => {
                    borrowers.add(event.args.borrower);
                    this.activeBorrowers.add(event.args.borrower);
                });
                
                if (events.length > 0) {
                    console.log(`   ${symbol}: Found ${events.length} borrow events`);
                }
                
            } catch (error) {
                console.error(`   Error fetching events for ${symbol}: ${error.message}`);
            }
        }
        
        console.log(`✅ Found ${borrowers.size} unique borrowers\n`);
        return Array.from(borrowers);
    }

    /**
     * Get list of active borrowers
     */
    getActiveBorrowers() {
        return Array.from(this.activeBorrowers);
    }

    /**
     * Add borrower manually
     */
    addBorrower(address) {
        this.activeBorrowers.add(address);
    }

    /**
     * Remove borrower manually
     */
    removeBorrower(address) {
        this.activeBorrowers.delete(address);
    }

    /**
     * Clear all active borrowers
     */
    clear() {
        this.activeBorrowers.clear();
    }

    /**
     * Get count of active borrowers
     */
    getCount() {
        return this.activeBorrowers.size;
    }
}

module.exports = EventMonitor;
