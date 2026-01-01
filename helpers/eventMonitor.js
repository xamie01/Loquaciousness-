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
                vToken.on("Borrow", (borrower, borrowAmount, accountBorrows, totalBorrows, event) => {
                    this.activeBorrowers.add(borrower);
                    console.log(`📊 Borrow event: ${borrower.substring(0, 10)}... borrowed from ${symbol}`);
                });
                
                // Listen for RepayBorrow events
                vToken.on("RepayBorrow", async (payer, borrower, repayAmount, accountBorrows, totalBorrows, event) => {
                    // Call borrowBalanceStored to verify if borrower has zero balance
                    // This is safer than relying on the event's accountBorrows parameter
                    try {
                        const currentBalance = await vToken.borrowBalanceStored(borrower);
                        
                        if (currentBalance === 0n) {
                            // Fully repaid, remove from active borrowers
                            this.activeBorrowers.delete(borrower);
                            console.log(`💰 Repay event: ${borrower.substring(0, 10)}... fully repaid ${symbol} (removed from tracking)`);
                        } else {
                            console.log(`💰 Repay event: ${borrower.substring(0, 10)}... partially repaid ${symbol} (balance: ${currentBalance.toString()})`);
                        }
                    } catch (error) {
                        // If verification fails, keep borrower in set to be safe
                        console.log(`   Warning: Could not verify balance for ${borrower.substring(0, 10)}... - ${error.message}`);
                    }
                });
                
                // Listen for LiquidateBorrow events
                vToken.on("LiquidateBorrow", (liquidator, borrower, repayAmount, vTokenCollateral, seizeTokens, event) => {
                    console.log(`⚡ Liquidation event: ${borrower.substring(0, 10)}... liquidated on ${symbol}`);
                    // Don't remove from set, they might still have other borrows
                });
                
                this.eventListeners.push({ vToken, symbol });
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
     * Prune borrowers with zero balances across all markets
     * Uses Multicall to efficiently check all borrowers in batches
     * @param {MulticallHelper} multicallHelper - Multicall helper instance
     * @returns {Object} { checked: number, pruned: number }
     */
    async pruneBorrowers(multicallHelper) {
        const borrowers = Array.from(this.activeBorrowers);
        if (borrowers.length === 0) {
            return { checked: 0, pruned: 0 };
        }

        console.log(`🧹 Pruning borrower list (checking ${borrowers.length} addresses)...`);
        
        const vTokenAddresses = Object.values(this.markets);
        
        // Use Multicall to get active borrowers (those with non-zero balances)
        const activeBorrowers = await multicallHelper.getActiveBorrowers(borrowers, vTokenAddresses);
        
        // Remove borrowers that no longer have any balances
        let prunedCount = 0;
        for (const borrower of borrowers) {
            if (!activeBorrowers.has(borrower)) {
                this.activeBorrowers.delete(borrower);
                prunedCount++;
            }
        }
        
        console.log(`   ✅ Pruned ${prunedCount} borrowers with zero balances (${this.activeBorrowers.size} remain)`);
        
        return { checked: borrowers.length, pruned: prunedCount };
    }

    /**
     * Get count of active borrowers
     */
    getCount() {
        return this.activeBorrowers.size;
    }
}

module.exports = EventMonitor;
