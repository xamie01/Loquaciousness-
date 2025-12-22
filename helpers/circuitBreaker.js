/**
 * helpers/circuitBreaker.js
 * 
 * Circuit breaker for detecting price manipulation and extreme market conditions
 * Implements safety checks recommended in Update.md
 */

const { ethers } = require("ethers");

class CircuitBreaker {
    constructor(oracle, markets) {
        this.oracle = oracle;
        this.markets = markets;
        this.priceHistory = new Map(); // Store price history for each market
        this.maxPriceChangePercent = 30; // 30% max price change per check
        this.historySize = 10; // Keep last 10 price points
        this.isTripped = false;
        this.tripReason = null;
    }

    /**
     * Initialize price history for all markets
     */
    async initialize() {
        console.log('🛡️  Initializing circuit breaker...');
        for (const [symbol, address] of Object.entries(this.markets)) {
            try {
                const price = await this.oracle.getUnderlyingPrice(address);
                this.priceHistory.set(address, [{ price, timestamp: Date.now() }]);
                console.log(`   ${symbol}: ${ethers.formatUnits(price, 18)} USD`);
            } catch (error) {
                console.error(`   Error initializing ${symbol}: ${error.message}`);
            }
        }
        console.log('✅ Circuit breaker initialized\n');
    }

    /**
     * Check if price movement is within acceptable range
     */
    async checkPrices() {
        if (this.isTripped) {
            return false;
        }

        try {
            for (const [symbol, address] of Object.entries(this.markets)) {
                const currentPrice = await this.oracle.getUnderlyingPrice(address);
                const history = this.priceHistory.get(address) || [];
                
                if (history.length === 0) {
                    // First price check, just store it
                    this.priceHistory.set(address, [{ price: currentPrice, timestamp: Date.now() }]);
                    continue;
                }

                const lastPrice = history[history.length - 1].price;
                
                // Calculate price change percentage
                const priceDiff = currentPrice > lastPrice 
                    ? currentPrice - lastPrice 
                    : lastPrice - currentPrice;
                
                const percentChange = lastPrice > 0n 
                    ? Number((priceDiff * 10000n) / lastPrice) / 100
                    : 0;

                // Check if price change exceeds threshold
                if (percentChange > this.maxPriceChangePercent) {
                    this.trip(
                        `Extreme price movement detected for ${symbol}: ${percentChange.toFixed(2)}% change`
                    );
                    return false;
                }

                // Update price history
                history.push({ price: currentPrice, timestamp: Date.now() });
                
                // Keep only last N prices
                if (history.length > this.historySize) {
                    history.shift();
                }
                
                this.priceHistory.set(address, history);
            }

            return true; // All prices are within acceptable range
        } catch (error) {
            console.error(`❌ Circuit breaker price check error: ${error.message}`);
            // On error, be conservative and trip the breaker
            this.trip(`Price check failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Trip the circuit breaker
     */
    trip(reason) {
        this.isTripped = true;
        this.tripReason = reason;
        console.error(`\n🚨 CIRCUIT BREAKER TRIPPED: ${reason}`);
        console.error(`   Bot operations halted for safety\n`);
    }

    /**
     * Manually reset the circuit breaker
     */
    async reset() {
        console.log('🔄 Resetting circuit breaker...');
        this.isTripped = false;
        this.tripReason = null;
        await this.initialize(); // Re-initialize price history
        console.log('✅ Circuit breaker reset\n');
    }

    /**
     * Get circuit breaker status
     */
    getStatus() {
        return {
            isTripped: this.isTripped,
            tripReason: this.tripReason,
            maxPriceChangePercent: this.maxPriceChangePercent
        };
    }

    /**
     * Check if circuit breaker allows operations
     */
    isOperational() {
        return !this.isTripped;
    }
}

module.exports = CircuitBreaker;
