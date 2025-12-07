/*
  Script to create a vulnerable borrower on a local fork for testing the Liquidator.

  Requirements (run on a Hardhat localhost fork):
  - .env must contain ETH_SEPOLIA_RPC_URL and AAVE_LENDING_POOL_ADDRESSES_PROVIDER
  - Provide COLLATERAL_TOKEN and BORROW_TOKEN addresses (or set via env)
  - Provide a WHALE_ADDRESS that has large amounts of the collateral token on the fork (or use a token deployer mock)

  Workflow:
  1) Impersonate BORROWER (create one if not provided) and a WHALE that supplies token liquidity.
  2) Transfer collateral from WHALE to BORROWER, approve LendingPool, deposit collateral.
  3) Borrow BORROW_TOKEN against that collateral (up to borrowAmount parameter).
  4) Optionally manipulate price by impersonating WHALE and swapping large collateral -> borrowToken on provided router to reduce collateral value.

  Usage (example):
    ETH_SEPOLIA_RPC_URL=http://127.0.0.1:8545 AAVE_LENDING_POOL_ADDRESSES_PROVIDER=0x... \
      COLLATERAL_TOKEN=0x.. BORROW_TOKEN=0x.. WHALE_ADDRESS=0x.. \
      node scripts/createVulnerableBorrower.js
*/

require('dotenv').config();
const hre = require('hardhat');
const { ethers } = hre;

async function resolveLendingPool() {
  const providerAddr = process.env.AAVE_LENDING_POOL_ADDRESSES_PROVIDER;
  if (!providerAddr) throw new Error('AAVE_LENDING_POOL_ADDRESSES_PROVIDER missing in .env');
  const artifactPath = '@aave/protocol-v2/artifacts/contracts/interfaces/ILendingPoolAddressesProvider.sol/ILendingPoolAddressesProvider.json';
  const apAbi = require(artifactPath).abi;
  const provider = new ethers.providers.JsonRpcProvider(process.env.ETH_SEPOLIA_RPC_URL || 'http://127.0.0.1:8545');
  const ap = new ethers.Contract(providerAddr, apAbi, provider);
  const lp = await ap.getLendingPool();
  return { lp, provider };
}

async function impersonate(address, provider) {
  await provider.send('hardhat_impersonateAccount', [address]);
  return provider.getSigner(address);
}

async function main() {
  console.log('createVulnerableBorrower.js - starting');
  const { lp, provider } = await resolveLendingPool();
  console.log('LendingPool at', lp);

  const COLLATERAL_TOKEN = process.env.COLLATERAL_TOKEN;
  const BORROW_TOKEN = process.env.BORROW_TOKEN;
  const WHALE_ADDRESS = process.env.WHALE_ADDRESS;
  let BORROWER = process.env.BORROWER_ADDRESS;
  const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || ethers.parseUnits('100', 18).toString(); // default 100 tokens
  const BORROW_AMOUNT = process.env.BORROW_AMOUNT || ethers.parseUnits('50', 18).toString(); // default 50 tokens
  const UNISWAP_ROUTER = process.env.UNISWAP_V2_ROUTER || process.env.UNISWAP_V3_ROUTER;

  if (!COLLATERAL_TOKEN || !BORROW_TOKEN) {
    console.error('Please set COLLATERAL_TOKEN and BORROW_TOKEN in .env');
    process.exit(1);
  }

  if (!WHALE_ADDRESS) {
    console.error('Please set WHALE_ADDRESS (an account that holds collateral token on fork)');
    process.exit(1);
  }

  const lendingPoolAbiPath = '@aave/protocol-v2/artifacts/contracts/interfaces/ILendingPool.sol/ILendingPool.json';
  const lendingPoolAbi = require(lendingPoolAbiPath).abi;
  const lendingPool = new ethers.Contract(lp, lendingPoolAbi, provider);

  // prepare borrower account
  if (!BORROWER) {
    const randomWallet = ethers.Wallet.createRandom();
    BORROWER = randomWallet.address;
    console.log('No BORROWER_ADDRESS provided — using generated address:', BORROWER);
    // fund with ETH so it can send txs after impersonation
    await provider.send('hardhat_setBalance', [BORROWER, ethers.utils.hexValue(ethers.parseEther('10'))]);
  }

  // Impersonate whale and send collateral to borrower
  console.log('Impersonating WHALE', WHALE_ADDRESS);
  await provider.send('hardhat_impersonateAccount', [WHALE_ADDRESS]);
  const whaleSigner = provider.getSigner(WHALE_ADDRESS);

  const erc20Abi = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)'
  ];

  const collateral = new ethers.Contract(COLLATERAL_TOKEN, erc20Abi, provider);
  const borrowerBalanceBefore = await collateral.balanceOf(BORROWER);
  console.log('Borrower collateral balance before:', borrowerBalanceBefore.toString());

  console.log(`Transferring ${DEPOSIT_AMOUNT} collateral from WHALE -> BORROWER`);
  const transferTx = await collateral.connect(whaleSigner).transfer(BORROWER, DEPOSIT_AMOUNT);
  await transferTx.wait();

  console.log('Transferring done. Approving LendingPool to pull collateral...');
  // impersonate borrower to approve and deposit
  await provider.send('hardhat_impersonateAccount', [BORROWER]);
  const borrowerSigner = provider.getSigner(BORROWER);
  const collateralAsBorrower = collateral.connect(borrowerSigner);
  await collateralAsBorrower.approve(lp, DEPOSIT_AMOUNT);

  console.log('Calling lendingPool.deposit(collateral)');
  const depositTx = await lendingPool.connect(borrowerSigner).deposit(COLLATERAL_TOKEN, DEPOSIT_AMOUNT, BORROWER, 0);
  await depositTx.wait();
  console.log('Deposit complete.');

  // Borrow asset
  console.log(`Attempting to borrow ${BORROW_AMOUNT} of ${BORROW_TOKEN}`);
  // Borrow via lendingPool.borrow(asset, amount, interestRateMode, referralCode, onBehalfOf)
  // Use interestRateMode = 2 (variable)
  const borrowTx = await lendingPool.connect(borrowerSigner).borrow(BORROW_TOKEN, BORROW_AMOUNT, 2, 0, BORROWER);
  await borrowTx.wait();
  console.log('Borrow complete.');

  // Check user account data
  const accountData = await lendingPool.getUserAccountData(BORROWER);
  console.log('UserAccountData:', {
    totalCollateralETH: accountData.totalCollateralETH.toString(),
    totalDebtETH: accountData.totalDebtETH.toString(),
    availableBorrowsETH: accountData.availableBorrowsETH.toString(),
    healthFactor: accountData.healthFactor.toString()
  });

  // Optional: manipulate price by having whale swap large amount of collateral into borrowToken on DEX
  if (UNISWAP_ROUTER) {
    console.log('Attempting price manipulation via router swap to push collateral price down...');
    // impersonate whale and swap collateral -> borrowToken to change pool prices (requires liquidity)
    const routerAbi = ['function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external returns (uint[] memory amounts)'];
    const router = new ethers.Contract(UNISWAP_ROUTER, routerAbi, provider);
    // approve router
    await collateral.connect(whaleSigner).approve(UNISWAP_ROUTER, DEPOSIT_AMOUNT);
    const path = [COLLATERAL_TOKEN, BORROW_TOKEN];
    const deadline = Math.floor(Date.now()/1000) + 60*10;
    try {
      const swapTx = await router.connect(whaleSigner).swapExactTokensForTokens(DEPOSIT_AMOUNT, 1, path, whaleSigner._address, deadline);
      await swapTx.wait();
      console.log('Swap executed to manipulate price.');
    } catch (e) {
      console.warn('Swap for price manipulation failed:', e.message || e);
    }
  } else {
    console.log('No UNISWAP_ROUTER set; skipping price manipulation.');
  }

  console.log('Done. Borrower should now be at risk if manipulation succeeded.');
  console.log('Check health factor via scripts/testLiquidation.js or liquidatorBot.js');
}

main().catch(e => { console.error(e); process.exit(1); });
