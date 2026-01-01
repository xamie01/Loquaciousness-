# Venus Liquidation Bot 💎

A sophisticated DeFi liquidation bot for Venus Protocol on Binance Smart Chain, featuring a modern web dashboard for monitoring and control.

![Dashboard](https://github.com/user-attachments/assets/af1983fd-8484-4d2b-a4e2-6ee3674ec692)

## ⭐ Recent Improvements

**Version 3.0** includes major performance and scalability enhancements:

- 🌐 **WebSocket Event Monitoring**: Push-based event detection reduces RPC calls by 80%
- ⚡ **Multicall Batching**: Single RPC call for multiple checks, O(1) instead of O(N)
- 🧹 **Automatic Pruning**: Periodic cleanup of zero-balance borrowers prevents bloat
- 💾 **Database Persistence**: SQLite storage for warm-starts and multi-instance coordination
- 🚀 **Concurrency Control**: Rate-limited parallel checks with p-limit
- 📜 **Enhanced Historical Seeding**: Configurable startup and periodic historical catches
- 🔒 **Improved Repay Handler**: Verified balance checks before borrower removal

See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for detailed documentation of new features.

**Version 2.0** includes significant enhancements for production use:

- 🛡️ **Emergency Controls**: Pause mechanism and emergency withdrawal functions
- ⚡ **Dynamic Gas Estimation**: Automatic gas optimization with 20% safety buffer
- 🔒 **Dashboard Authentication**: API key protection for bot control endpoints
- 🚨 **Circuit Breaker**: Price manipulation detection and automatic safety halt
- 📡 **Real-time Event Monitoring**: WebSocket-based borrower discovery for faster detection
- 📊 **Enhanced Monitoring**: Improved Telegram commands and status reporting

See [IMPROVEMENTS.md](./IMPROVEMENTS.md) for detailed documentation.

## Features

### 🤖 Automated Liquidation
- Monitors Venus Protocol for underwater positions
- Executes profitable liquidations automatically
- Uses PancakeSwap V3 flash loans (0% fees!)
- Optimizes for maximum profit with minimal gas costs
- **NEW**: Dynamic gas estimation for optimal efficiency

### 🌐 Web Dashboard
- **Real-time monitoring** with WebSocket updates
- **Beautiful UI** with smooth animations
- **Interactive controls** (Start/Stop bot from browser)
- **Live statistics** (Profit, liquidations, balance tracking)
- **Responsive design** for desktop and mobile
- **Toast notifications** for important events
- **NEW**: Optional API key authentication for security

### 💰 Profit Optimization
- Automatic profit calculation before execution
- Configurable minimum profit threshold
- Slippage protection
- Gas price optimization
- Close factor compliance
- **NEW**: Dynamic gas estimation with 20% buffer

### 🛡️ Safety Features
- **Circuit Breaker**: Detects extreme price movements (>30%) and halts operations
- **Pause Mechanism**: Emergency pause for liquidation contract
- **Emergency Withdrawal**: Rescue stuck funds from contract
- **Event Monitoring**: Real-time borrower tracking for faster response

## Quick Start

### Prerequisites
- Node.js 18 or higher
- BSC RPC endpoint (QuickNode, Nodereal, etc.)
- Wallet with BNB for gas fees
- Telegram bot token (for notifications)

### Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd Loquaciousness-
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**
```bash
cp .env.example .env
# Edit .env with your configuration
```

Required environment variables:
```env
PRIVATE_KEY=your_wallet_private_key
BSC_RPC_QUICKNODE=your_bsc_rpc_endpoint
BSC_RPC_WSS=wss://your_websocket_endpoint  # NEW: For WebSocket event monitoring
LIQUIDATION_CONTRACT_ADDRESS=your_deployed_contract
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
DASHBOARD_PORT=3000  # Optional, defaults to 3000

# NEW: Performance and database options
USE_EVENT_MONITORING=true  # Enable WebSocket event monitoring (recommended)
DATABASE_URL=./borrowers.db  # Enable database persistence (recommended)
MAX_CONCURRENT_CHECKS=5  # Rate limiting for parallel checks
BORROWER_PRUNING_INTERVAL_MS=300000  # Prune zero-balance borrowers every 5 min
```

4. **Deploy liquidation contract** (if not already deployed)
```bash
npx hardhat compile
npx hardhat run scripts/deploy-liquidation.js --network bsc
```

### Running the Bot

#### With Web Dashboard (Recommended) 🌟
```bash
npm run dashboard
```

Then open http://localhost:3000 in your browser to access the dashboard.

#### CLI Only
```bash
npm start
```

Runs the bot without the web interface (uses Telegram for notifications only).

## Dashboard Features

The web dashboard provides:

- **Bot Control Panel**: Start/Stop the bot with a single click
- **Live Statistics**: 
  - Total profit earned
  - Number of successful liquidations
  - Current wallet balance
  - Active borrowers being monitored
- **Recent Liquidations**: Complete history with transaction links
- **Current Opportunities**: Real-time list of potential liquidations
- **System Information**: Network status, configuration, and metrics
- **Connection Status**: Live WebSocket connection indicator
- **Toast Notifications**: Real-time alerts for liquidations and errors

See [DASHBOARD.md](DASHBOARD.md) for complete dashboard documentation.

## Architecture

### Smart Contracts
- `BSC_LiquidationV3.sol`: Main liquidation contract with flash loan integration
- Uses PancakeSwap V3 for 0% fee flash loans
- Automatic token swapping via PancakeSwap V3

### Bot Components
- `bscLiquidationBot.js`: Original CLI bot
- `botWithDashboard.js`: Bot wrapper with dashboard integration
- `server.js`: Express server with WebSocket support
- `helpers/`: Utility modules for Venus interaction, profit calculation, etc.

### Frontend
- `public/index.html`: Dashboard interface
- `public/css/style.css`: Modern styling with animations
- `public/js/app.js`: WebSocket client and UI logic

## Configuration

### Bot Parameters

Edit the bot configuration in `botWithDashboard.js` or `bscLiquidationBot.js`:

```javascript
MIN_PROFIT_THRESHOLD = 0.01 BNB      // Minimum profit to execute
MAX_LIQUIDATION_SIZE = 100 BNB       // Maximum position size
POLLING_INTERVAL = 10000ms           // How often to check for opportunities
BORROWER_REFRESH_INTERVAL = 60000ms  // How often to refresh borrower list
```

### New Configuration Options

```bash
# Enable real-time event monitoring (recommended)
USE_EVENT_MONITORING=true

# Dashboard API key for authentication (recommended for production)
DASHBOARD_API_KEY=your-secret-key-here
```

See [IMPROVEMENTS.md](./IMPROVEMENTS.md) for complete configuration guide.

### Supported Markets

The bot monitors these Venus markets:
- vBNB (Wrapped BNB)
- vUSDT (Tether)
- vBUSD (Binance USD)
- vBTC (Bitcoin)
- vETH (Ethereum)
- vUSDC (USD Coin)

## Telegram Commands

When running, the bot responds to these Telegram commands:

- `/start` - Start the liquidation bot
- `/stop` - Stop the liquidation bot
- `/status` - Get current bot status and statistics (includes circuit breaker and event monitor status)
- `/reset` - Reset circuit breaker after verifying prices are safe
- `/events` - View event monitor status and active borrower count

See [IMPROVEMENTS.md](./IMPROVEMENTS.md) for detailed command descriptions.

## Development

### Project Structure
```
.
├── contracts/              # Solidity smart contracts
├── helpers/               # Bot utility modules
├── public/                # Frontend dashboard files
│   ├── css/
│   ├── js/
│   └── index.html
├── scripts/               # Deployment and test scripts
├── test/                  # Contract tests
├── bscLiquidationBot.js   # Main CLI bot
├── botWithDashboard.js    # Bot with dashboard
├── server.js              # Web server
├── DASHBOARD.md           # Dashboard documentation
└── RUNBOOK.md            # Operational guide
```

### Running Tests
```bash
npm test
```

### Compiling Contracts
```bash
npm run compile
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Never commit your `.env` file** - It contains sensitive credentials
2. **Use a dedicated wallet** for the bot with limited funds
3. **Test on testnet first** before running on mainnet
4. **Monitor gas prices** to avoid losses
5. **Set reasonable profit thresholds** to account for slippage
6. **The dashboard should only be accessible on localhost** or behind authentication in production
7. **Regularly check for smart contract vulnerabilities**

## Monitoring

The bot provides multiple monitoring options:

1. **Web Dashboard**: Real-time visual monitoring at http://localhost:3000
2. **Telegram Notifications**: Instant alerts for liquidations and errors
3. **Console Logs**: Detailed logging to stdout
4. **Transaction History**: All liquidations logged with BSCScan links

## Troubleshooting

### Dashboard won't connect
- Verify the server is running on the correct port
- Check browser console for WebSocket errors
- Ensure no firewall is blocking the connection

### Bot not finding opportunities
- Check RPC connection is working
- Verify Venus Protocol is accessible
- Increase the polling interval if hitting rate limits
- Check if there are any underwater positions on Venus

### Liquidations failing
- Ensure sufficient BNB for gas fees
- Check if profit threshold is too high
- Verify liquidation contract is deployed correctly
- Review recent transactions on BSCScan for error messages

See [RUNBOOK.md](RUNBOOK.md) for detailed operational procedures.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - See LICENSE file for details.

## Disclaimer

This software is for educational purposes only. Use at your own risk. The authors are not responsible for any financial losses incurred through the use of this bot. Always test thoroughly on testnet before deploying to mainnet.

---

**Built with ❤️ for DeFi**

