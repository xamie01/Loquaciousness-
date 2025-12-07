const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

async function main() {
    console.log("\n" + "=".repeat(70));
    console.log("   DEPLOYING BSC LIQUIDATION CONTRACT");
    console.log("=".repeat(70) + "\n");

    // BSC addresses
    const PANCAKE_V3_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
    const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
    const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384";

    console.log("📋 Configuration:");
    console.log("   Network: BSC Mainnet");
    console.log("   PancakeSwap V3 Router:", PANCAKE_V3_ROUTER);
    console.log("   PancakeSwap V3 Factory:", PANCAKE_V3_FACTORY);
    console.log("   Venus Comptroller:", VENUS_COMPTROLLER);
    console.log("   Flash Loans: PancakeSwap V3 (0% FEES!)\n");

    const [deployer] = await hre.ethers.getSigners();
    console.log("👤 Deploying from:", deployer.address);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("💰 Balance:", hre.ethers.formatEther(balance), "BNB\n");

    if (balance < hre.ethers.parseEther("0.01")) {
        console.error("❌ Insufficient BNB for deployment!");
        process.exit(1);
    }

    console.log("⏳ Deploying BSC_LiquidationV3 contract...\n");

    const BSC_LiquidationV3 = await hre.ethers.getContractFactory("BSC_LiquidationV3");
    const contract = await BSC_LiquidationV3.deploy(
        PANCAKE_V3_ROUTER,
        PANCAKE_V3_FACTORY,
        VENUS_COMPTROLLER
    );

    await contract.waitForDeployment();
    const contractAddress = await contract.getAddress();

    console.log("✅ CONTRACT DEPLOYED SUCCESSFULLY!\n");
    console.log("=".repeat(70));
    console.log("📍 Contract Address:", contractAddress);
    console.log("🔗 BscScan:", `https://bscscan.com/address/${contractAddress}`);
    console.log("=".repeat(70) + "\n");

    // Update .env file
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    if (envContent.includes('LIQUIDATION_CONTRACT_ADDRESS=')) {
        envContent = envContent.replace(
            /LIQUIDATION_CONTRACT_ADDRESS=.*/,
            `LIQUIDATION_CONTRACT_ADDRESS=${contractAddress}`
        );
    } else {
        envContent += `\nLIQUIDATION_CONTRACT_ADDRESS=${contractAddress}\n`;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log("✅ Updated .env with contract address\n");

    console.log("📝 NEXT STEPS:\n");
    console.log("1. Verify contract (optional):");
    console.log(`   npx hardhat verify --network bsc ${contractAddress} \\`);
    console.log(`     "${PANCAKE_V3_ROUTER}" \\`);
    console.log(`     "${PANCAKE_V3_FACTORY}" \\`);
    console.log(`     "${VENUS_COMPTROLLER}"\n`);
    
    console.log("2. Start the bot:");
    console.log("   node bscLiquidationBot.js\n");
    
    console.log("3. Or use PM2:");
    console.log("   pm2 start bscLiquidationBot.js --name liquidation-bot\n");

    console.log("=".repeat(70) + "\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ DEPLOYMENT FAILED:\n", error);
        process.exit(1);
    });
