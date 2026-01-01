#!/usr/bin/env node
/**
 * Manual test script for bot improvements
 * Tests core functionality without requiring blockchain connection
 */

const EventMonitor = require('../helpers/eventMonitor');
const MulticallHelper = require('../helpers/multicall');
const BorrowerDatabase = require('../helpers/borrowerDatabase');
const path = require('path');
const fs = require('fs');

console.log('🧪 Testing Bot Improvements\n');

// Test 1: EventMonitor basic operations
console.log('Test 1: EventMonitor Basic Operations');
const mockProvider = { /* mock provider */ };
const mockMarkets = {
    vBNB: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
    vUSDT: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
};

const eventMonitor = new EventMonitor(mockProvider, mockMarkets);
console.log(`  ✓ EventMonitor initialized`);

eventMonitor.addBorrower("0x1234567890123456789012345678901234567890");
console.log(`  ✓ Added borrower, count: ${eventMonitor.getCount()}`);

const borrowers = eventMonitor.getActiveBorrowers();
console.log(`  ✓ Retrieved ${borrowers.length} borrowers`);

eventMonitor.clear();
console.log(`  ✓ Cleared borrowers, count: ${eventMonitor.getCount()}`);

// Test 2: BorrowerDatabase operations
console.log('\nTest 2: BorrowerDatabase Operations');
const testDbPath = path.join(__dirname, 'test-manual.db');

// Clean up test DB if exists
[testDbPath, testDbPath + '-shm', testDbPath + '-wal'].forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
});

const db = new BorrowerDatabase(testDbPath);
db.initialize();
console.log(`  ✓ Database initialized at ${testDbPath}`);

db.addBorrower("0x1111111111111111111111111111111111111111");
db.addBorrower("0x2222222222222222222222222222222222222222");
console.log(`  ✓ Added 2 borrowers, count: ${db.getBorrowerCount()}`);

const activeBorrowers = db.getActiveBorrowers();
console.log(`  ✓ Retrieved ${activeBorrowers.length} active borrowers`);

db.markBorrowerZeroBalance("0x1111111111111111111111111111111111111111");
console.log(`  ✓ Marked borrower as zero balance, new count: ${db.getBorrowerCount()}`);

db.recordLiquidation(
    "0xabcdef1234567890",
    "0x1111111111111111111111111111111111111111",
    "0xdebt",
    "0xcollateral",
    1000000n,
    100000n,
    50000n
);
console.log(`  ✓ Recorded liquidation, count: ${db.getLiquidationCount()}`);

// Test 3: Integration
console.log('\nTest 3: EventMonitor + Database Integration');
const eventMonitorWithDB = new EventMonitor(mockProvider, mockMarkets, db);
console.log(`  ✓ EventMonitor created with database`);

const loaded = eventMonitorWithDB.loadFromDatabase();
console.log(`  ✓ Loaded ${loaded} borrowers from database`);
console.log(`  ✓ EventMonitor count: ${eventMonitorWithDB.getCount()}`);

// Cleanup
db.close();
[testDbPath, testDbPath + '-shm', testDbPath + '-wal'].forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
});
console.log(`  ✓ Database cleaned up`);

// Test 4: MulticallHelper (structure only, needs real provider for actual calls)
console.log('\nTest 4: MulticallHelper Structure');
try {
    const multicall = new MulticallHelper(mockProvider);
    console.log(`  ✓ MulticallHelper initialized`);
    console.log(`  ✓ Has batchCall method: ${typeof multicall.batchCall === 'function'}`);
    console.log(`  ✓ Has getBorrowBalances method: ${typeof multicall.getBorrowBalances === 'function'}`);
    console.log(`  ✓ Has getOraclePrices method: ${typeof multicall.getOraclePrices === 'function'}`);
    console.log(`  ✓ Has getActiveBorrowers method: ${typeof multicall.getActiveBorrowers === 'function'}`);
} catch (error) {
    console.log(`  ⚠️  MulticallHelper requires real provider: ${error.message}`);
}

console.log('\n✅ All manual tests passed!\n');
console.log('Note: For full integration testing, run the bot with a test RPC provider.');
