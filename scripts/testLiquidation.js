/* Test helper scaffold for local fork testing. 
   This script is a placeholder to show where you'd simulate a vulnerable account and call the liquidator.
   You must adapt it to the protocol and addresses you will use.
*/

require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

async function resolveLendingPool() {
  if (!process.env.AAVE_LENDING_POOL_ADDRESSES_PROVIDER) throw new Error('AAVE_LENDING_POOL_ADDRESSES_PROVIDER missing in .env');
  const artifactPath = '@aave/protocol-v2/artifacts/contracts/interfaces/ILendingPoolAddressesProvider.sol/ILendingPoolAddressesProvider.json';
  const addressesProviderAbi = require(artifactPath).abi;
  const provider = new ethers.providers.JsonRpcProvider(process.env.ETH_SEPOLIA_RPC_URL || 'http://127.0.0.1:8545');
  const ap = new ethers.Contract(process.env.AAVE_LENDING_POOL_ADDRESSES_PROVIDER, addressesProviderAbi, provider);
  const lp = await ap.getLendingPool();
  return { lp, provider };
}

async function main() {
  const LIQUIDATOR_ADDRESS = process.env.LIQUIDATOR_ADDRESS;
  if (!LIQUIDATOR_ADDRESS) {
    console.error('Please set LIQUIDATOR_ADDRESS in .env (deploy with scripts/deployLiquidator.js)');
    process.exit(1);
  }

  const monitored = (process.env.MONITORED_ADDRESSES || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (monitored.length === 0) {
    console.log('No MONITORED_ADDRESSES found in .env.');
    console.log('To create a test borrower you can:');
    console.log(' - Start a local fork: npx hardhat node --fork $ETH_SEPOLIA_RPC_URL');
    console.log(' - Run deployMocks or manipulate scripts to seed liquidity / create positions:');
    console.log('   npx hardhat run scripts/deployMocks.js --network localhost');
    console.log('   npx hardhat run scripts/v3manipulate.js --network localhost');
    console.log('\nThen set MONITORED_ADDRESSES in .env to the address you want to test and re-run this script.');
    process.exit(0);
  }

  const { lp, provider } = await resolveLendingPool();
  console.log('Resolved LendingPool:', lp);

  const liquidatorArtifact = await hre.artifacts.readArtifact('Liquidator');
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const liquidator = new ethers.Contract(LIQUIDATOR_ADDRESS, liquidatorArtifact.abi, signer);

  const lendingPoolAbiPath = '@aave/protocol-v2/artifacts/contracts/interfaces/ILendingPool.sol/ILendingPool.json';
  const lendingPoolAbi = require(lendingPoolAbiPath).abi;
  const lendingPool = new ethers.Contract(lp, lendingPoolAbi, provider);

  for (const addr of monitored) {
    try {
      const data = await lendingPool.getUserAccountData(addr);
      const healthFactor = BigInt(data.healthFactor.toString());
      console.log(`Address ${addr} healthFactor=${healthFactor}`);
      if (healthFactor < BigInt(1e18)) {
        console.log(' -> Under-collateralized candidate. Preparing liquidation simulation.');
        const totalDebtETH = BigInt(data.totalDebtETH.toString());
        const repayAmount = totalDebtETH / BigInt(2);

        const debtToken = process.env.TEST_DEBT_TOKEN || '0x0000000000000000000000000000000000000000';
        const collateralToken = process.env.TEST_COLLATERAL_TOKEN || '0x0000000000000000000000000000000000000000';

        try {
          console.log('Running callStatic.executeLiquidation to simulate...');
          const sim = await liquidator.callStatic.executeLiquidation(1, addr, debtToken, repayAmount.toString(), collateralToken, '0x');
          console.log('Simulation succeeded:', sim);
        } catch (simErr) {
          console.warn('Simulation reverted or failed:', simErr.message || simErr);
        }

        if (process.env.DRY_RUN === 'false') {
          try {
            console.log('Executing liquidation tx...');
            const tx = await liquidator.executeLiquidation(1, addr, debtToken, repayAmount.toString(), collateralToken, '0x');
            const receipt = await tx.wait();
            console.log('Liquidation tx mined:', receipt.transactionHash);
          } catch (execErr) {
            console.error('Execution failed:', execErr.message || execErr);
          }
        } else {
          console.log('DRY_RUN=true, not executing on-chain. Set DRY_RUN=false in .env to execute.');
        }
      } else {
        console.log(' -> Health factor ok, skipping.');
      }
    } catch (err) {
      console.error('Error handling address', addr, err.message || err);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
