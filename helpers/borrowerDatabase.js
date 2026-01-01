/**
 * helpers/borrowerDatabase.js
 * 
 * Database persistence layer for borrower tracking
 * Supports warm-start, multi-instance coordination, and analytics
 */

const Database = require('better-sqlite3');
const path = require('path');

class BorrowerDatabase {
    constructor(dbPath = null) {
        // Default to SQLite file in project root
        this.dbPath = dbPath || process.env.DATABASE_URL || path.join(__dirname, '..', 'borrowers.db');
        this.db = null;
        // Check if DATABASE_URL is truthy and not empty string
        // Empty string should disable database, not use default path
        this.isEnabled = (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '') || dbPath !== null;
    }

    /**
     * Initialize database and create tables
     */
    initialize() {
        if (!this.isEnabled) {
            console.log('📊 Database persistence disabled (set DATABASE_URL to enable)');
            return;
        }

        try {
            this.db = new Database(this.dbPath);
            
            // Enable WAL mode for better concurrency
            this.db.pragma('journal_mode = WAL');
            
            // Create borrowers table
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS borrowers (
                    address TEXT PRIMARY KEY,
                    first_seen INTEGER NOT NULL,
                    last_seen INTEGER NOT NULL,
                    last_checked INTEGER,
                    has_balance BOOLEAN DEFAULT 1,
                    total_borrows TEXT DEFAULT '0',
                    market_count INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL
                )
            `);
            
            // Create borrower_markets table (tracks borrows per market)
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS borrower_markets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    borrower_address TEXT NOT NULL,
                    vtoken_address TEXT NOT NULL,
                    balance TEXT NOT NULL,
                    last_updated INTEGER NOT NULL,
                    UNIQUE(borrower_address, vtoken_address),
                    FOREIGN KEY(borrower_address) REFERENCES borrowers(address) ON DELETE CASCADE
                )
            `);
            
            // Create liquidations table (for analytics)
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS liquidations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tx_hash TEXT UNIQUE NOT NULL,
                    borrower_address TEXT NOT NULL,
                    debt_token TEXT NOT NULL,
                    collateral_token TEXT NOT NULL,
                    repay_amount TEXT NOT NULL,
                    profit_bnb TEXT NOT NULL,
                    gas_used TEXT,
                    timestamp INTEGER NOT NULL
                )
            `);
            
            // Create indexes for faster queries
            this.db.exec(`
                CREATE INDEX IF NOT EXISTS idx_borrowers_has_balance ON borrowers(has_balance);
                CREATE INDEX IF NOT EXISTS idx_borrowers_last_seen ON borrowers(last_seen);
                CREATE INDEX IF NOT EXISTS idx_borrower_markets_address ON borrower_markets(borrower_address);
                CREATE INDEX IF NOT EXISTS idx_liquidations_borrower ON liquidations(borrower_address);
                CREATE INDEX IF NOT EXISTS idx_liquidations_timestamp ON liquidations(timestamp);
            `);
            
            console.log(`✅ Database initialized: ${this.dbPath}`);
            console.log(`   Borrowers tracked: ${this.getBorrowerCount()}`);
            
        } catch (error) {
            console.error('❌ Database initialization failed:', error.message);
            this.isEnabled = false;
        }
    }

    /**
     * Add or update a borrower
     */
    addBorrower(address) {
        if (!this.isEnabled || !this.db) return;
        
        try {
            const now = Date.now();
            const stmt = this.db.prepare(`
                INSERT INTO borrowers (address, first_seen, last_seen, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(address) DO UPDATE SET
                    last_seen = ?,
                    has_balance = 1
            `);
            
            stmt.run(address, now, now, now, now);
        } catch (error) {
            console.error(`Error adding borrower ${address}:`, error.message);
        }
    }

    /**
     * Add multiple borrowers in a batch
     */
    addBorrowersBatch(addresses) {
        if (!this.isEnabled || !this.db) return;
        
        const insert = this.db.prepare(`
            INSERT INTO borrowers (address, first_seen, last_seen, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(address) DO UPDATE SET
                last_seen = ?,
                has_balance = 1
        `);
        
        const insertMany = this.db.transaction((borrowers) => {
            const now = Date.now();
            for (const address of borrowers) {
                insert.run(address, now, now, now, now);
            }
        });
        
        try {
            insertMany(addresses);
        } catch (error) {
            console.error('Error adding borrowers batch:', error.message);
        }
    }

    /**
     * Mark borrower as having zero balance
     */
    markBorrowerZeroBalance(address) {
        if (!this.isEnabled || !this.db) return;
        
        try {
            const stmt = this.db.prepare(`
                UPDATE borrowers
                SET has_balance = 0, last_checked = ?
                WHERE address = ?
            `);
            
            stmt.run(Date.now(), address);
        } catch (error) {
            console.error(`Error marking borrower ${address}:`, error.message);
        }
    }

    /**
     * Get all active borrowers (with balance)
     */
    getActiveBorrowers() {
        if (!this.isEnabled || !this.db) return [];
        
        try {
            const stmt = this.db.prepare(`
                SELECT address FROM borrowers
                WHERE has_balance = 1
                ORDER BY last_seen DESC
            `);
            
            const rows = stmt.all();
            return rows.map(row => row.address);
        } catch (error) {
            console.error('Error getting active borrowers:', error.message);
            return [];
        }
    }

    /**
     * Update borrower market balances
     */
    updateBorrowerMarkets(borrowerAddress, marketBalances) {
        if (!this.isEnabled || !this.db) return;
        
        const insert = this.db.prepare(`
            INSERT INTO borrower_markets (borrower_address, vtoken_address, balance, last_updated)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(borrower_address, vtoken_address) DO UPDATE SET
                balance = ?,
                last_updated = ?
        `);
        
        try {
            const now = Date.now();
            const updateMany = this.db.transaction(() => {
                for (const [vToken, data] of Object.entries(marketBalances)) {
                    const balance = data.balance.toString();
                    insert.run(borrowerAddress, vToken, balance, now, balance, now);
                }
            });
            
            updateMany();
        } catch (error) {
            console.error(`Error updating markets for ${borrowerAddress}:`, error.message);
        }
    }

    /**
     * Record a liquidation
     */
    recordLiquidation(txHash, borrowerAddress, debtToken, collateralToken, repayAmount, profitBnb, gasUsed) {
        if (!this.isEnabled || !this.db) return;
        
        try {
            const stmt = this.db.prepare(`
                INSERT INTO liquidations (
                    tx_hash, borrower_address, debt_token, collateral_token,
                    repay_amount, profit_bnb, gas_used, timestamp
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tx_hash) DO NOTHING
            `);
            
            stmt.run(
                txHash,
                borrowerAddress,
                debtToken,
                collateralToken,
                repayAmount.toString(),
                profitBnb.toString(),
                gasUsed?.toString() || null,
                Date.now()
            );
        } catch (error) {
            console.error('Error recording liquidation:', error.message);
        }
    }

    /**
     * Get borrower count
     */
    getBorrowerCount() {
        if (!this.isEnabled || !this.db) return 0;
        
        try {
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM borrowers WHERE has_balance = 1');
            const row = stmt.get();
            return row.count;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get liquidation count
     */
    getLiquidationCount() {
        if (!this.isEnabled || !this.db) return 0;
        
        try {
            const stmt = this.db.prepare('SELECT COUNT(*) as count FROM liquidations');
            const row = stmt.get();
            return row.count;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get total profit from liquidations
     */
    getTotalProfit() {
        if (!this.isEnabled || !this.db) return '0';
        
        try {
            const stmt = this.db.prepare('SELECT SUM(CAST(profit_bnb AS REAL)) as total FROM liquidations');
            const row = stmt.get();
            return row.total || '0';
        } catch (error) {
            return '0';
        }
    }

    /**
     * Clean up old borrowers (optional maintenance)
     */
    cleanupOldBorrowers(daysOld = 30) {
        if (!this.isEnabled || !this.db) return 0;
        
        try {
            const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
            const stmt = this.db.prepare(`
                DELETE FROM borrowers
                WHERE has_balance = 0 AND last_seen < ?
            `);
            
            const result = stmt.run(cutoff);
            return result.changes;
        } catch (error) {
            console.error('Error cleaning up old borrowers:', error.message);
            return 0;
        }
    }

    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            console.log('✅ Database connection closed');
        }
    }
}

module.exports = BorrowerDatabase;
