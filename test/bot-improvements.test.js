/**
 * test/bot-improvements.test.js
 * 
 * Tests for the bot improvements: Multicall, EventMonitor, Database
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const MulticallHelper = require("../helpers/multicall");
const EventMonitor = require("../helpers/eventMonitor");
const BorrowerDatabase = require("../helpers/borrowerDatabase");
const path = require("path");
const fs = require("fs");

describe("Bot Improvements", function () {
    let provider;
    
    before(function () {
        provider = ethers.provider;
    });

    describe("MulticallHelper", function () {
        let multicall;
        
        beforeEach(function () {
            multicall = new MulticallHelper(provider);
        });

        it("Should initialize with correct Multicall3 address", function () {
            expect(multicall.multicall.target).to.equal("0xcA11bde05977b3631167028862bE2a173976CA11");
        });

        it("Should have batchCall method", function () {
            expect(typeof multicall.batchCall).to.equal("function");
        });

        it("Should have getBorrowBalances method", function () {
            expect(typeof multicall.getBorrowBalances).to.equal("function");
        });

        it("Should have getOraclePrices method", function () {
            expect(typeof multicall.getOraclePrices).to.equal("function");
        });

        it("Should have getActiveBorrowers method", function () {
            expect(typeof multicall.getActiveBorrowers).to.equal("function");
        });
    });

    describe("EventMonitor", function () {
        let eventMonitor;
        const VENUS_MARKETS = {
            vBNB: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
            vUSDT: "0xfD5840Cd36d94D7229439859C0112a4185BC0255",
        };
        
        beforeEach(function () {
            eventMonitor = new EventMonitor(provider, VENUS_MARKETS);
        });

        it("Should initialize with empty borrower set", function () {
            expect(eventMonitor.getCount()).to.equal(0);
        });

        it("Should add borrowers manually", function () {
            const testAddress = "0x1234567890123456789012345678901234567890";
            eventMonitor.addBorrower(testAddress);
            expect(eventMonitor.getCount()).to.equal(1);
            expect(eventMonitor.getActiveBorrowers()).to.include(testAddress);
        });

        it("Should remove borrowers manually", function () {
            const testAddress = "0x1234567890123456789012345678901234567890";
            eventMonitor.addBorrower(testAddress);
            eventMonitor.removeBorrower(testAddress);
            expect(eventMonitor.getCount()).to.equal(0);
        });

        it("Should clear all borrowers", function () {
            eventMonitor.addBorrower("0x1234567890123456789012345678901234567890");
            eventMonitor.addBorrower("0x0987654321098765432109876543210987654321");
            expect(eventMonitor.getCount()).to.equal(2);
            eventMonitor.clear();
            expect(eventMonitor.getCount()).to.equal(0);
        });

        it("Should have startListening method", function () {
            expect(typeof eventMonitor.startListening).to.equal("function");
        });

        it("Should have stopListening method", function () {
            expect(typeof eventMonitor.stopListening).to.equal("function");
        });

        it("Should have pruneBorrowers method", function () {
            expect(typeof eventMonitor.pruneBorrowers).to.equal("function");
        });

        it("Should have loadFromDatabase method", function () {
            expect(typeof eventMonitor.loadFromDatabase).to.equal("function");
        });
    });

    describe("BorrowerDatabase", function () {
        let db;
        const testDbPath = path.join(__dirname, "test-borrowers.db");
        
        beforeEach(function () {
            // Remove test DB if it exists
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
            if (fs.existsSync(testDbPath + '-shm')) {
                fs.unlinkSync(testDbPath + '-shm');
            }
            if (fs.existsSync(testDbPath + '-wal')) {
                fs.unlinkSync(testDbPath + '-wal');
            }
            
            db = new BorrowerDatabase(testDbPath);
            db.initialize();
        });

        afterEach(function () {
            db.close();
            // Clean up test DB
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
            if (fs.existsSync(testDbPath + '-shm')) {
                fs.unlinkSync(testDbPath + '-shm');
            }
            if (fs.existsSync(testDbPath + '-wal')) {
                fs.unlinkSync(testDbPath + '-wal');
            }
        });

        it("Should initialize database successfully", function () {
            expect(db.isEnabled).to.be.true;
            expect(db.db).to.not.be.null;
        });

        it("Should add a borrower", function () {
            const testAddress = "0x1234567890123456789012345678901234567890";
            db.addBorrower(testAddress);
            expect(db.getBorrowerCount()).to.equal(1);
        });

        it("Should add multiple borrowers in batch", function () {
            const addresses = [
                "0x1234567890123456789012345678901234567890",
                "0x0987654321098765432109876543210987654321",
                "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
            ];
            db.addBorrowersBatch(addresses);
            expect(db.getBorrowerCount()).to.equal(3);
        });

        it("Should mark borrower as zero balance", function () {
            const testAddress = "0x1234567890123456789012345678901234567890";
            db.addBorrower(testAddress);
            expect(db.getBorrowerCount()).to.equal(1);
            
            db.markBorrowerZeroBalance(testAddress);
            expect(db.getBorrowerCount()).to.equal(0);
        });

        it("Should get active borrowers", function () {
            const addresses = [
                "0x1234567890123456789012345678901234567890",
                "0x0987654321098765432109876543210987654321"
            ];
            db.addBorrowersBatch(addresses);
            
            const activeBorrowers = db.getActiveBorrowers();
            expect(activeBorrowers.length).to.equal(2);
            expect(activeBorrowers).to.include(addresses[0]);
            expect(activeBorrowers).to.include(addresses[1]);
        });

        it("Should record a liquidation", function () {
            const txHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const borrower = "0x1234567890123456789012345678901234567890";
            
            db.recordLiquidation(
                txHash,
                borrower,
                "0xdebt",
                "0xcollateral",
                1000000n,
                100000n,
                50000n
            );
            
            expect(db.getLiquidationCount()).to.equal(1);
        });

        it("Should not duplicate liquidations", function () {
            const txHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const borrower = "0x1234567890123456789012345678901234567890";
            
            // Record same liquidation twice
            db.recordLiquidation(txHash, borrower, "0xdebt", "0xcollateral", 1000000n, 100000n, 50000n);
            db.recordLiquidation(txHash, borrower, "0xdebt", "0xcollateral", 1000000n, 100000n, 50000n);
            
            // Should only have one entry
            expect(db.getLiquidationCount()).to.equal(1);
        });

        it("Should clean up old borrowers", function () {
            const oldAddress = "0x1234567890123456789012345678901234567890";
            db.addBorrower(oldAddress);
            db.markBorrowerZeroBalance(oldAddress);
            
            // Clean up borrowers older than 0 days (all of them)
            const cleaned = db.cleanupOldBorrowers(0);
            expect(cleaned).to.be.greaterThan(0);
        });
    });

    describe("Integration", function () {
        let eventMonitor;
        let db;
        const testDbPath = path.join(__dirname, "test-integration.db");
        const VENUS_MARKETS = {
            vBNB: "0xA07c5b74C9B40447a954e1466938b865b6BBea36",
        };
        
        beforeEach(function () {
            // Remove test DB if it exists
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
            if (fs.existsSync(testDbPath + '-shm')) {
                fs.unlinkSync(testDbPath + '-shm');
            }
            if (fs.existsSync(testDbPath + '-wal')) {
                fs.unlinkSync(testDbPath + '-wal');
            }
            
            db = new BorrowerDatabase(testDbPath);
            db.initialize();
            eventMonitor = new EventMonitor(provider, VENUS_MARKETS, db);
        });

        afterEach(function () {
            db.close();
            // Clean up test DB
            if (fs.existsSync(testDbPath)) {
                fs.unlinkSync(testDbPath);
            }
            if (fs.existsSync(testDbPath + '-shm')) {
                fs.unlinkSync(testDbPath + '-shm');
            }
            if (fs.existsSync(testDbPath + '-wal')) {
                fs.unlinkSync(testDbPath + '-wal');
            }
        });

        it("Should integrate EventMonitor with Database", function () {
            const testAddress = "0x1234567890123456789012345678901234567890";
            
            // Add borrower through event monitor
            eventMonitor.addBorrower(testAddress);
            
            // Should be in event monitor
            expect(eventMonitor.getCount()).to.equal(1);
        });

        it("Should load borrowers from database on warm start", function () {
            const addresses = [
                "0x1234567890123456789012345678901234567890",
                "0x0987654321098765432109876543210987654321"
            ];
            
            // Add to database directly
            db.addBorrowersBatch(addresses);
            
            // Load into event monitor
            const loaded = eventMonitor.loadFromDatabase();
            
            expect(loaded).to.equal(2);
            expect(eventMonitor.getCount()).to.equal(2);
        });
    });
});
