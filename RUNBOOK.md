# Runbook: BSC Liquidation Bot

## Prerequisites
- Node.js 18+ and npm
- RPC endpoint for BSC (QuickNode/Nodereal/etc.)
- Private key with BSC funds for gas
- Deployed liquidation contract address (from `BSC_LiquidationV3.sol`)

## Environment
Create `.env` (or reuse `.env.example`):
```
PRIVATE_KEY=0x...
BSC_RPC_QUICKNODE=https://...
LIQUIDATION_CONTRACT_ADDRESS=0x...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
MIN_OUT_BPS=100
```
Optional tuning: `GAS_PRICE_MULTIPLIER`, `MAX_GAS_PRICE_GWEI`, `USE_EVENT_MONITORING`, `DATABASE_URL`.

## Install dependencies
```
npm install
```

## Compile contracts
```
npx hardhat compile
```

## Deploy liquidation contract
Update network config in `hardhat.config.js` (BSC mainnet/testnet), then:
```
# Example mainnet deploy (add your deploy script if different)
npx hardhat run scripts/deploy-liquidation.js --network bsc
```
Set `LIQUIDATION_CONTRACT_ADDRESS` in `.env` to the deployed address.

## Run the bot (main process)
```
npm start
```
Behavior: polls Venus, evaluates profit with `MIN_OUT_BPS` buffer, sends Telegram alerts.

## Mock/offline test of profit math
```
node scripts/mockFlowTest.js
```

## Common utilities
- Verify env/setup:
```
npx hardhat verify --network bsc <DEPLOYED_ADDRESS> <constructor args>
```
- Format/clean (if configured):
```
npx hardhat clean
```

## Notes
- Ensure the RPC has sufficient rate limits; the bot uses throttled borrower polling.
- Keep `MIN_OUT_BPS` > 0 to protect profit against slippage.
- For vBNB, the bot passes `address(0)` and the contract wraps/unwraps WBNB automatically.
