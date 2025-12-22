// Web Server with WebSocket Integration for Dashboard
// This server runs alongside the bot and provides real-time updates

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

class DashboardServer {
    constructor(botInstance) {
        this.bot = botInstance;
        this.app = express();
        this.server = http.createServer(this.app);
        
        // Configure CORS - restrict to localhost for security
        // In production, set ALLOWED_ORIGINS environment variable
        const allowedOrigins = process.env.ALLOWED_ORIGINS 
            ? process.env.ALLOWED_ORIGINS.split(',')
            : ['http://localhost:3000', 'http://127.0.0.1:3000'];
        
        this.io = socketIO(this.server, {
            cors: {
                origin: allowedOrigins,
                methods: ['GET', 'POST']
            }
        });

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }

    setupMiddleware() {
        // Apply same CORS restrictions to Express as Socket.io for consistency
        const allowedOrigins = process.env.ALLOWED_ORIGINS 
            ? process.env.ALLOWED_ORIGINS.split(',')
            : ['http://localhost:3000', 'http://127.0.0.1:3000'];
        
        this.app.use(cors({
            origin: allowedOrigins,
            credentials: true
        }));
        
        // Rate limiting to prevent abuse
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 100, // Limit each IP to 100 requests per windowMs
            message: 'Too many requests from this IP, please try again later.',
            standardHeaders: true,
            legacyHeaders: false,
        });
        
        this.app.use(limiter);
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));
        
        // Simple authentication middleware for API endpoints
        // Set DASHBOARD_API_KEY in environment for production
        this.authMiddleware = (req, res, next) => {
            const apiKey = process.env.DASHBOARD_API_KEY;
            
            // Skip auth if no API key is configured (development mode)
            if (!apiKey) {
                console.warn('⚠️  No DASHBOARD_API_KEY set. Authentication disabled.');
                return next();
            }
            
            // Accept API key only via header for security (not in query params)
            // Query params are logged in access logs, browser history, and referrer headers
            const providedKey = req.headers['x-api-key'];
            
            if (providedKey !== apiKey) {
                return res.status(401).json({ 
                    success: false, 
                    message: 'Unauthorized: Invalid or missing API key. Use x-api-key header.' 
                });
            }
            
            next();
        };
    }

    setupRoutes() {
        // Serve the dashboard
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public/index.html'));
        });

        // API endpoints with authentication
        this.app.get('/api/status', (req, res) => {
            res.json(this.getStatus());
        });

        this.app.post('/api/start', this.authMiddleware, (req, res) => {
            this.bot.start();
            res.json({ success: true, message: 'Bot started' });
        });

        this.app.post('/api/stop', this.authMiddleware, (req, res) => {
            this.bot.stop();
            res.json({ success: true, message: 'Bot stopped' });
        });
    }

    setupWebSocket() {
        this.io.on('connection', (socket) => {
            console.log('📱 Dashboard client connected');

            // Send initial status
            socket.emit('status', this.getStatus());

            // Handle bot control commands
            socket.on('startBot', () => {
                this.bot.start();
                // Emit actual bot state instead of hardcoded value
                this.io.emit('botStateChanged', { isRunning: this.bot.isRunning });
            });

            socket.on('stopBot', () => {
                this.bot.stop();
                // Emit actual bot state instead of hardcoded value
                this.io.emit('botStateChanged', { isRunning: this.bot.isRunning });
            });

            socket.on('requestStatus', () => {
                socket.emit('status', this.getStatus());
            });

            socket.on('disconnect', () => {
                console.log('📱 Dashboard client disconnected');
            });
        });
    }

    getStatus() {
        return {
            isRunning: this.bot.isRunning || false,
            stats: {
                totalProfit: this.bot.getTotalProfit ? this.bot.getTotalProfit() : '0.00',
                liquidationCount: this.bot.getLiquidationCount ? this.bot.getLiquidationCount() : 0,
                walletBalance: this.bot.getWalletBalance ? this.bot.getWalletBalance() : '0.00',
                activeBorrowers: this.bot.getActiveBorrowers ? this.bot.getActiveBorrowers() : 0
            },
            systemInfo: {
                currentBlock: this.bot.getCurrentBlock ? this.bot.getCurrentBlock() : '-',
                walletAddress: this.bot.getWalletAddress ? this.bot.getWalletAddress() : '-',
                minProfit: this.bot.getMinProfit ? this.bot.getMinProfit() : '0.01',
                pollingInterval: this.bot.getPollingInterval ? this.bot.getPollingInterval() : '10'
            },
            recentLiquidations: this.bot.getRecentLiquidations ? this.bot.getRecentLiquidations() : [],
            opportunities: this.bot.getCurrentOpportunities ? this.bot.getCurrentOpportunities() : []
        };
    }

    // Methods to emit events from the bot
    emitLiquidationFound(data) {
        this.io.emit('liquidationFound', data);
    }

    emitLiquidationExecuted(data) {
        this.io.emit('liquidationExecuted', data);
    }

    emitLiquidationFailed(data) {
        this.io.emit('liquidationFailed', data);
    }

    emitStatsUpdate(data) {
        this.io.emit('statsUpdate', data);
    }

    emitError(error) {
        this.io.emit('error', error);
    }

    start(port = 3000) {
        return new Promise((resolve, reject) => {
            this.server.listen(port, (err) => {
                if (err) {
                    reject(err);
                } else {
                    console.log(`\n🌐 Dashboard server running on http://localhost:${port}`);
                    console.log(`   Open your browser and navigate to the URL above\n`);
                    resolve();
                }
            });
        });
    }
}

module.exports = DashboardServer;
