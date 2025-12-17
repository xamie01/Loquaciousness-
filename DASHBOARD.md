# Venus Liquidation Bot - Dashboard Frontend

A modern, aesthetically pleasing web dashboard for monitoring and controlling the Venus Protocol liquidation bot on BSC.

## Features

✨ **Real-time Monitoring**
- Live bot status and statistics
- Real-time liquidation notifications
- WebSocket-based updates (no page refresh needed)

💎 **Beautiful UI**
- Modern dark theme with gradient accents
- Smooth animations and transitions
- Responsive design for mobile and desktop
- Toast notifications for important events

⚡ **Bot Control**
- Start/Stop bot from the web interface
- View liquidation history
- Monitor current opportunities
- Track profit and performance metrics

🎯 **Key Metrics Display**
- Total profit in BNB
- Number of successful liquidations
- Wallet balance
- Active borrowers count
- Current block number

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Make sure you have a `.env` file with the required variables:

```env
PRIVATE_KEY=your_private_key
BSC_RPC_QUICKNODE=your_rpc_url
LIQUIDATION_CONTRACT_ADDRESS=your_contract_address
TELEGRAM_BOT_TOKEN=your_telegram_token
TELEGRAM_CHAT_ID=your_chat_id
DASHBOARD_PORT=3000  # Optional, defaults to 3000
```

### 3. Run the Bot with Dashboard

```bash
npm run dashboard
```

This will start both the liquidation bot and the web dashboard server.

### 4. Access the Dashboard

Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

### Bot Controls

- **Start Bot**: Click the green "Start Bot" button to begin monitoring
- **Stop Bot**: Click the red "Stop Bot" button to pause monitoring
- **Refresh Status**: Click the "Refresh Status" button to get latest data

### Dashboard Sections

1. **Control Panel**: Start/stop the bot and view current status
2. **Statistics Grid**: Key performance metrics at a glance
3. **Recent Liquidations**: History of successful liquidations with transaction links
4. **Current Opportunities**: Real-time list of potential liquidations being evaluated
5. **System Information**: Network details, contract addresses, and configuration

### Real-time Updates

The dashboard automatically receives updates for:
- Bot state changes (started/stopped)
- New liquidation opportunities found
- Successful liquidations executed
- Failed liquidation attempts
- Statistics updates

## Architecture

### Frontend Stack
- **HTML5** - Semantic markup
- **CSS3** - Modern styling with animations
- **Vanilla JavaScript** - No framework overhead
- **Socket.io Client** - Real-time WebSocket communication

### Backend Stack
- **Node.js** - Runtime environment
- **Express** - Web server
- **Socket.io** - WebSocket server
- **Ethers.js** - Blockchain interaction

### File Structure

```
.
├── public/                  # Frontend files
│   ├── index.html          # Main dashboard HTML
│   ├── css/
│   │   └── style.css       # Styles with animations
│   └── js/
│       └── app.js          # Frontend application logic
├── server.js               # Dashboard server with WebSocket
├── botWithDashboard.js     # Bot wrapper with dashboard integration
└── bscLiquidationBot.js    # Original CLI bot (still works standalone)
```

## Running Options

### Option 1: Bot with Dashboard (Recommended)
```bash
npm run dashboard
```
Access the web UI at http://localhost:3000

### Option 2: CLI Bot Only (Original)
```bash
npm start
```
Runs the bot without the web interface

## Customization

### Change Dashboard Port

Set the `DASHBOARD_PORT` environment variable:
```env
DASHBOARD_PORT=8080
```

### Modify Styling

Edit `/public/css/style.css` to customize:
- Colors (CSS variables at the top)
- Animations
- Layout
- Responsiveness

### Extend Functionality

1. Add new API endpoints in `server.js`
2. Create corresponding frontend handlers in `/public/js/app.js`
3. Update the UI in `/public/index.html`

## Troubleshooting

### Dashboard won't connect
- Check that the server is running on the correct port
- Verify no firewall is blocking the connection
- Look for errors in the browser console

### Bot not responding to controls
- Ensure environment variables are set correctly
- Check server logs for error messages
- Verify WebSocket connection is established

### Slow updates
- Check your RPC connection speed
- Consider reducing the polling interval
- Verify network connectivity

## Security Notes

⚠️ **Important Security Considerations:**

1. The dashboard does NOT expose private keys
2. Access should be restricted to localhost or trusted networks
3. Use proper authentication for production deployments
4. Never commit `.env` files to version control
5. Consider using a reverse proxy (nginx) for production

## Browser Compatibility

- ✅ Chrome/Edge (recommended)
- ✅ Firefox
- ✅ Safari
- ✅ Opera
- ⚠️ IE11 not supported

## Performance

- Lightweight frontend (< 50KB total)
- Real-time updates with minimal latency
- Optimized WebSocket communication
- Efficient DOM updates

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT License - See LICENSE file for details

---

Built with ❤️ for DeFi
