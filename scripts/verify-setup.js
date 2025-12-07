// scripts/verify-setup.js
// Complete diagnostic to verify your bot is configured correctly

require("dotenv").config();
const ethers = require("ethers");
const fs = require('fs');
const path = require('path');

console.log("\n🔍 COMPLETE SETUP VERIFICATION\n");
console.log("=".repeat(70));

let issues = [];
let warnings = [];
let success = [];

// ============================================
// 1. CHECK .ENV FILE
// ============================================
console.log("\n📋 Step 1: Checking .env file...\n");

// Check required variables
const requiredVars = ['PRIVATE_KEY', 'ARB_FOR', 'ARB_AGAINST_TOKENS'];
for (const varName of requiredVars) {
    if (!process.env[varName]) {
        issues.push(`Missing ${varName} in .env`);
        console.log(`❌ ${varName}: Missing`);
    } else {
        success.push(`${varName} configured`);
        console.log(`✅ ${varName}: Found`);
    }
}

// Check for spaces in RPC URLs
const rpcVars = Object.keys(process.env).filter(k => k.includes('RPC'));
for (const rpcVar of rpcVars) {
    const url = process.env[rpcVar];
    if (url && url.startsWith(' ')) {
        issues.push(`${rpcVar} has space before URL`);
        console.log(`❌ ${rpcVar}: Has space before https (REMOVE IT!)`);
    } else if (url) {
        success.push(`${rpcVar} formatted correctly`);
        console.log(`✅ ${rpcVar}: OK`);
    }
}

// Check RPC count
const validRpcs = rpcVars.filter(v => process.env[v] && !process.env[v].startsWith(' '));
if (validRpcs.length === 0) {
    issues.push("No valid RPC endpoints found");
    console.log(`❌ No valid RPC endpoints`);
} else if (validRpcs.length === 1) {
    warnings.push("Only 1 RPC endpoint (add more for rotation)");
    console.log(`⚠️  Only ${validRpcs.length} RPC (add more for rotation)`);
} else {
    success.push(`${validRpcs.length} RPC endpoints configured`);
    console.log(`✅ ${validRpcs.length} RPC endpoints configured`);
}

// Check Telegram
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    success.push("Telegram configured");
    console.log(`✅ Telegram: Configured`);
} else {
    warnings.push("Telegram not configured (optional)");
    console.log(`ℹ️  Telegram: Disabled (optional)`);
}

// ============================================
// 2. CHECK CONFIG.JSON
// ============================================
console.log("\n📋 Step 2: Checking config.json...\n");

let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    success.push("config.json loaded");
    console.log(`✅ config.json: Loaded successfully`);
} catch (error) {
    issues.push("config.json not found or invalid");
    console.log(`❌ config.json: ${error.message}`);
}

if (config) {
    // Check required addresses
    const requiredAddresses = [
        { path: 'UNISWAPV3.FACTORY_ADDRESS', expected: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
        { path: 'CAMELOT_V3.FACTORY_ADDRESS', expected: '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B' },
        { path: 'UNISWAPV3.QUOTER_V2_ADDRESS', expected: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' },
        { path: 'CAMELOT_V3.QUOTER_ADDRESS', expected: '0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E' }
    ];

    for (const { path: configPath, expected } of requiredAddresses) {
        const keys = configPath.split('.');
        let value = config;
        for (const key of keys) {
            value = value?.[key];
        }
        
        if (!value) {
            issues.push(`Missing ${configPath}`);
            console.log(`❌ ${configPath}: Missing`);
        } else if (value.toLowerCase() !== expected.toLowerCase()) {
            warnings.push(`${configPath} might be incorrect`);
            console.log(`⚠️  ${configPath}: ${value.substring(0, 10)}... (verify this is correct)`);
        } else {
            success.push(`${configPath} correct`);
            console.log(`✅ ${configPath}: Correct`);
        }
    }
    
    // Check contract address
    const contractAddr = config?.PROJECT_SETTINGS?.ARBITRAGE_V3_ADDRESS;
    if (!contractAddr || contractAddr === "YOUR_DEPLOYED_CONTRACT_ADDRESS_HERE") {
        warnings.push("ArbitrageV3 contract address not set");
        console.log(`⚠️  Contract Address: Not set (need to deploy)`);
    } else if (ethers.isAddress(contractAddr)) {
        success.push("Contract address configured");
        console.log(`✅ Contract Address: ${contractAddr.substring(0, 10)}...`);
    } else {
        issues.push("Invalid contract address");
        console.log(`❌ Contract Address: Invalid format`);
    }
}

// ============================================
// 3. TEST RPC CONNECTION
// ============================================
console.log("\n📋 Step 3: Testing RPC connection...\n");

async function testRPC() {
    try {
        const rpcUrl = process.env.ARBITRUM_RPC_ALCHEMY || 
                      process.env.ARBITRUM_RPC_INFURA || 
                      process.env.ARBITRUM_RPC_PUBLIC ||
                      "https://arb1.arbitrum.io/rpc";
        
        console.log(`   Connecting to: ${rpcUrl.substring(0, 50)}...`);
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        
        const blockNumber = await provider.getBlockNumber();
        success.push("RPC connection working");
        console.log(`✅ RPC Connected: Block ${blockNumber}`);
    } catch (error) {
        issues.push("RPC connection failed");
        console.log(`❌ RPC Connection: ${error.message}`);
    }
}

// ============================================
// 4. CHECK WALLET
// ============================================
console.log("\n📋 Step 4: Checking wallet...\n");

async function testWallet() {
    try {
        const rpcUrl = process.env.ARBITRUM_RPC_ALCHEMY || 
                      process.env.ARBITRUM_RPC_INFURA || 
                      process.env.ARBITRUM_RPC_PUBLIC ||
                      "https://arb1.arbitrum.io/rpc";
        
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        
        if (!process.env.PRIVATE_KEY.startsWith('0x')) {
            issues.push("PRIVATE_KEY must start with 0x");
            console.log(`❌ Private Key: Must start with 0x`);
        } else {
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
            const address = wallet.address;
            const balance = await provider.getBalance(address);
            const balanceEth = ethers.formatEther(balance);
            
            console.log(`✅ Wallet Address: ${address}`);
            console.log(`   Balance: ${balanceEth} ETH`);
            
            if (parseFloat(balanceEth) < 0.01) {
                warnings.push("Low wallet balance (need at least 0.01 ETH for gas)");
                console.log(`⚠️  Balance is low! Add more ETH for gas`);
            } else {
                success.push("Wallet has sufficient balance");
            }
        }
    } catch (error) {
        issues.push("Wallet check failed: " + error.message);
        console.log(`❌ Wallet: ${error.message}`);
    }
}

// ============================================
// 5. CHECK TOKEN ADDRESSES
// ============================================
console.log("\n📋 Step 5: Checking token addresses...\n");

if (process.env.ARB_FOR && ethers.isAddress(process.env.ARB_FOR)) {
    success.push("Base token address valid");
    console.log(`✅ Base Token (ARB_FOR): ${process.env.ARB_FOR.substring(0, 10)}...`);
} else {
    issues.push("Invalid ARB_FOR address");
    console.log(`❌ Base Token: Invalid address`);
}

if (process.env.ARB_AGAINST_TOKENS) {
    const tokens = process.env.ARB_AGAINST_TOKENS.split(',').map(t => t.trim());
    const validTokens = tokens.filter(t => ethers.isAddress(t));
    
    console.log(`   Target Tokens: ${validTokens.length}/${tokens.length} valid`);
    
    if (validTokens.length === 0) {
        issues.push("No valid target tokens");
        console.log(`❌ No valid target token addresses`);
    } else if (validTokens.length !== tokens.length) {
        warnings.push(`${tokens.length - validTokens.length} invalid token addresses`);
        console.log(`⚠️  Some token addresses are invalid`);
    } else {
        success.push(`${validTokens.length} target tokens configured`);
        console.log(`✅ All ${validTokens.length} token addresses valid`);
    }
}

// ============================================
// 6. CHECK POOL AVAILABILITY
// ============================================
console.log("\n📋 Step 6: Checking pool availability...\n");

async function testPools() {
    try {
        const rpcUrl = process.env.ARBITRUM_RPC_ALCHEMY || 
                      process.env.ARBITRUM_RPC_PUBLIC ||
                      "https://arb1.arbitrum.io/rpc";
        
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        
        if (config) {
            const factoryAbi = ["function getPool(address, address, uint24) view returns (address)"];
            
            const uniFactory = new ethers.Contract(
                config.UNISWAPV3.FACTORY_ADDRESS,
                factoryAbi,
                provider
            );
            
            const camelotFactory = new ethers.Contract(
                config.CAMELOT_V3.FACTORY_ADDRESS,
                factoryAbi,
                provider
            );
            
            // Check WETH/USDC pool as test
            const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
            const USDC = "0x4Cb9a7AE498CEDcBb5EAe9f25736aE7d428C9D66";
            
            console.log(`   Testing WETH/USDC pools...`);
            
            let uniPoolFound = false;
            let camelotPoolFound = false;
            
            // Check fee tiers
            for (const fee of [500, 3000, 10000]) {
                try {
                    const uniPool = await uniFactory.getPool(WETH, USDC, fee);
                    if (uniPool !== ethers.ZeroAddress) {
                        uniPoolFound = true;
                        console.log(`   ✅ Uniswap V3: Pool exists (${fee/10000}% fee)`);
                        break;
                    }
                } catch (e) {
                    // Pool doesn't exist
                }
            }
            
            for (const fee of [500, 3000, 10000]) {
                try {
                    const camelotPool = await camelotFactory.getPool(WETH, USDC, fee);
                    if (camelotPool !== ethers.ZeroAddress) {
                        camelotPoolFound = true;
                        console.log(`   ✅ Camelot V3: Pool exists (${fee/10000}% fee)`);
                        break;
                    }
                } catch (e) {
                    // Pool doesn't exist
                }
            }
            
            if (!uniPoolFound) {
                issues.push("No Uniswap V3 WETH/USDC pool found");
                console.log(`   ❌ Uniswap V3: No WETH/USDC pool found`);
            }
            
            if (!camelotPoolFound) {
                warnings.push("No Camelot V3 WETH/USDC pool found");
                console.log(`   ⚠️  Camelot V3: No WETH/USDC pool found`);
                console.log(`       This might be normal - Camelot may not have all pairs`);
                console.log(`       Consider using Sushiswap V3 instead`);
            }
            
            if (uniPoolFound && camelotPoolFound) {
                success.push("Both DEXes have WETH/USDC pools");
                console.log(`   🎯 Arbitrage possible on WETH/USDC!`);
            }
        }
    } catch (error) {
        warnings.push("Pool check failed: " + error.message);
        console.log(`   ⚠️  Pool Check: ${error.message}`);
    }
}

// ============================================
// RUN ALL ASYNC TESTS
// ============================================
async function runTests() {
    await testRPC();
    await testWallet();
    await testPools();
    
    // ============================================
    // 7. SUMMARY
    // ============================================
    console.log("\n" + "=".repeat(70));
    console.log("\n📊 VERIFICATION SUMMARY\n");

    console.log(`✅ Success: ${success.length} checks passed`);
    console.log(`⚠️  Warnings: ${warnings.length} items need attention`);
    console.log(`❌ Issues: ${issues.length} critical problems\n`);

    if (issues.length > 0) {
        console.log("🚨 CRITICAL ISSUES (Must fix before running):\n");
        issues.forEach((issue, i) => {
            console.log(`   ${i + 1}. ${issue}`);
        });
        console.log();
    }

    if (warnings.length > 0) {
        console.log("⚠️  WARNINGS (Recommended to fix):\n");
        warnings.forEach((warning, i) => {
            console.log(`   ${i + 1}. ${warning}`);
        });
        console.log();
    }

    // ============================================
    // 8. RECOMMENDATIONS
    // ============================================
    console.log("=".repeat(70));
    console.log("\n💡 RECOMMENDATIONS\n");

    if (issues.length === 0 && warnings.length === 0) {
        console.log("🎉 Your setup is PERFECT! You're ready to start the bot!\n");
        console.log("Next steps:");
        console.log("   1. Start the bot: node v3Mainnet.js");
        console.log("   2. Monitor console for price checks");
        console.log("   3. Wait for profitable opportunities\n");
    } else if (issues.length === 0) {
        console.log("✅ Your setup is GOOD with minor warnings.\n");
        console.log("You can start the bot, but consider fixing warnings for better performance:\n");
        
        if (warnings.some(w => w.includes("Only 1 RPC"))) {
            console.log("📍 Add more RPC endpoints:");
            console.log("   ARBITRUM_RPC_PUBLIC=https://arb1.arbitrum.io/rpc");
            console.log("   ARBITRUM_RPC_LLAMARPC=https://arbitrum.llamarpc.com\n");
        }
        
        if (warnings.some(w => w.includes("Camelot"))) {
            console.log("📍 If Camelot has no pools, use Sushiswap V3 instead:");
            console.log("   Factory: 0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e");
            console.log("   Quoter:  0x0524E833cCD057e4d7A296e3aaAb9f7675964Ce1\n");
        }
        
        if (warnings.some(w => w.includes("balance"))) {
            console.log("📍 Add more ETH to your wallet:");
            console.log("   Minimum: 0.01 ETH for gas");
            console.log("   Recommended: 0.1 ETH\n");
        }
    } else {
        console.log("❌ Your setup has CRITICAL ISSUES that must be fixed.\n");
        console.log("Fix these issues first:\n");
        
        if (issues.some(i => i.includes("space before URL"))) {
            console.log("📍 Fix RPC URLs in .env:");
            console.log("   Remove all spaces after = sign");
            console.log("   Example: RPC_URL=https://... (no space!)\n");
        }
        
        if (issues.some(i => i.includes("config.json"))) {
            console.log("📍 Create or fix config.json:");
            console.log("   Copy the config.json from artifacts");
            console.log("   Place it in your project root\n");
        }
        
        if (issues.some(i => i.includes("Missing"))) {
            console.log("📍 Add missing variables to .env:");
            console.log("   Check the .env.example file");
            console.log("   Add all required variables\n");
        }
        
        if (issues.some(i => i.includes("Contract address"))) {
            console.log("📍 Deploy the arbitrage contract:");
            console.log("   npx hardhat run scripts/deploy-camelot.js --network arbitrum");
            console.log("   Add address to config.json\n");
        }
    }

    // ============================================
    // 9. NEXT STEPS
    // ============================================
    console.log("=".repeat(70));
    console.log("\n🚀 NEXT STEPS\n");

    if (issues.length === 0) {
        console.log("1. Review any warnings above");
        console.log("2. Run: node scripts/check-pools.js (verify pools exist)");
        console.log("3. Run: node scripts/test-rpc-rotation.js (test RPC rotation)");
        console.log("4. Run: node v3Mainnet.js (start the bot!)");
        console.log("5. Monitor console logs for opportunities\n");
    } else {
        console.log("1. Fix all critical issues listed above");
        console.log("2. Run this script again: node scripts/verify-setup.js");
        console.log("3. Once all issues are fixed, proceed with testing\n");
    }

    console.log("=".repeat(70));
    console.log();

    // Exit with appropriate code
    if (issues.length > 0) {
        console.log("❌ Verification failed. Fix issues and try again.\n");
        process.exit(1);
    } else if (warnings.length > 0) {
        console.log("⚠️  Verification passed with warnings.\n");
        process.exit(0);
    } else {
        console.log("✅ Verification passed! You're ready to go!\n");
        process.exit(0);
    }
}

// Run all tests
runTests().catch(error => {
    console.error("\n💥 Fatal error during verification:", error);
    process.exit(1);
});
