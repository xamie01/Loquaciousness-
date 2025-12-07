/**
 * Test liquidation bot locally on BSC fork
 * Usage: npx hardhat run scripts/test-liquidation-local.js --network localhost
 */

require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
    console.log("🧪 Testing Liquidation Bot on Local Fork\n");

    // This requires you to fork BSC mainnet
    // Run: npx hardhat node --fork https://bsc-dataseed.binance.org/
    
    const provider = ethers.provider;
    const [signer] = await ethers.getSigners();
    
    console.log("👤 Signer:", signer.address);
    console.log("💰 Balance:", ethers.formatEther(await provider.getBalance(signer.address)), "BNB\n");

    // Venus Comptroller
    const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";
    const comptrollerAbi = [
        "function getAllMarkets() external view returns (address[])",
        "function getAccountLiquidity(address) external view returns (uint, uint, uint)"
    ];
    
    const comptroller = new ethers.Contract(VENUS_COMPTROLLER, comptrollerAbi, provider);
    
    // Get all Venus markets
    console.log("📊 Fetching Venus markets...");
    const markets = await comptroller.getAllMarkets();
    console.log(`Found ${markets.length} markets\n`);
    
    // Find a borrower to test (you'd need to create one or use real data)
    console.log("🔍 Looking for underwater positions...");
    
    // In production, you'd have a database of borrowers
    // For testing, you can impersonate a known underwater account
    const TEST_BORROWER = "0x..."; // Replace with actual underwater account
    
    if (TEST_BORROWER !== "0x...") {
        const [error, liquidity, shortfall] = await comptroller.getAccountLiquidity(TEST_BORROWER);
        
        console.log(`Borrower: ${TEST_BORROWER}`);
        console.log(`Liquidity: ${ethers.formatEther(liquidity)} USD`);
        console.log(`Shortfall: ${ethers.formatEther(shortfall)} USD`);
        console.log(`Liquidatable: ${shortfall > 0n ? '✅ YES' : '❌ NO'}\n`);
        
        if (shortfall > 0n) {
            console.log("💡 This borrower can be liquidated!");
            console.log("Run the main bot to execute liquidation");
        }
    } else {
        console.log("⚠️ No test borrower configured");
        console.log("Set TEST_BORROWER to a real underwater address");
    }
}

main().catch(console.error);
