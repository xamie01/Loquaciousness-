// scripts/mockFlowTest.js
// Offline mock to exercise the liquidation profit pipeline without on-chain calls.
// Run with: node scripts/mockFlowTest.js

const { ethers } = require("ethers");
const {
  calculateCollateralSeized,
  calculateLiquidationProfit
} = require("../helpers/liquidationCalculator");

// Simple assert helper
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function formatBn(bn) {
  return ethers.formatEther(bn);
}

async function main() {
  // Mocked oracle prices (18 decimals, USD)
  const priceUSD = (usd) => ethers.parseUnits(usd.toString(), 18);

  const debtTokenPrice = priceUSD(1);      // e.g., USDC ~$1
  const collateralTokenPrice = priceUSD(1.05); // e.g., slightly more valuable collateral
  const liquidationIncentive = ethers.parseUnits("1.08", 18); // 8% bonus

  // Mock position
  const repayAmount = ethers.parseEther("1000"); // repay 1000 debt tokens

  // Expected seized collateral given oracle prices + incentive
  const collateralReceived = calculateCollateralSeized(
    repayAmount,
    debtTokenPrice,
    collateralTokenPrice,
    liquidationIncentive
  );

  // Convert collateral back to debt terms using oracle ratio
  const collateralToDebtRate = (collateralTokenPrice * ethers.parseEther("1")) / debtTokenPrice;

  // Mock gas and slippage assumptions
  const gasPrice = ethers.parseUnits("5", "gwei");
  const estimatedGasUnits = 600000n;
  const slippage = 0.01; // 1%

  const profit = calculateLiquidationProfit(
    repayAmount,
    collateralReceived,
    collateralToDebtRate,
    gasPrice,
    estimatedGasUnits,
    slippage
  );

  console.log("\n═══════════════════════════════════════");
  console.log("Mock Liquidation Flow (Offline)");
  console.log("═══════════════════════════════════════");
  console.log("Repay Amount:", formatBn(repayAmount));
  console.log("Collateral Seized:", formatBn(collateralReceived));
  console.log("Gas Cost (BNB equiv):", formatBn(profit.gasCost));
  console.log("Gross Profit (debt token):", formatBn(profit.grossProfit));
  console.log("Net Profit (debt token):", formatBn(profit.netProfit));
  console.log("Is Profitable:", profit.isProfitable ? "YES" : "NO");
  console.log("ROI (bps):", profit.roi.toString());
  console.log("═══════════════════════════════════════\n");

  // Basic expectations for the mock setup
  assert(profit.isProfitable, "Expected scenario to be profitable in mock");
  assert(profit.netProfit > 0n, "Net profit should be positive");
  assert(profit.gasCost > 0n, "Gas cost should be non-zero");

  console.log("✅ Mock flow test passed.");
}

main().catch((err) => {
  console.error("Mock flow test failed:", err.message);
  process.exit(1);
});
