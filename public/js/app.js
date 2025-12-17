// Frontend Application Logic
class DashboardApp {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.botRunning = false;
        this.liquidations = [];
        this.opportunities = [];
        
        this.init();
    }

    init() {
        this.connectWebSocket();
        this.setupEventListeners();
        this.updateTimestamp();
        setInterval(() => this.updateTimestamp(), 1000);
    }

    connectWebSocket() {
        this.socket = io();

        this.socket.on('connect', () => {
            this.isConnected = true;
            this.updateConnectionStatus(true);
            this.showToast('success', 'Connected', 'WebSocket connection established');
            
            // Request initial status
            this.socket.emit('requestStatus');
        });

        this.socket.on('disconnect', () => {
            this.isConnected = false;
            this.updateConnectionStatus(false);
            this.showToast('error', 'Disconnected', 'Connection lost. Attempting to reconnect...');
        });

        this.socket.on('status', (data) => {
            this.updateDashboard(data);
        });

        this.socket.on('botStateChanged', (data) => {
            this.botRunning = data.isRunning;
            this.updateBotStatus(data.isRunning);
            const message = data.isRunning ? 'Bot started successfully' : 'Bot stopped';
            this.showToast('info', 'Bot Status', message);
        });

        this.socket.on('liquidationFound', (data) => {
            this.addOpportunity(data);
            this.showToast('warning', 'Opportunity Found', `Potential profit: ${data.expectedProfit}`);
        });

        this.socket.on('liquidationExecuted', (data) => {
            this.addLiquidation(data);
            this.removeOpportunity(data.borrower);
            this.showToast('success', 'Liquidation Success!', `Profit: ${data.profit}`);
        });

        this.socket.on('liquidationFailed', (data) => {
            this.showToast('error', 'Liquidation Failed', data.reason || 'Unknown error');
        });

        this.socket.on('statsUpdate', (data) => {
            this.updateStats(data);
        });

        this.socket.on('error', (error) => {
            this.showToast('error', 'Error', error.message || 'An error occurred');
        });
    }

    setupEventListeners() {
        document.getElementById('startBtn').addEventListener('click', () => {
            this.socket.emit('startBot');
            this.disableButton('startBtn');
            setTimeout(() => this.enableButton('startBtn'), 2000);
        });

        document.getElementById('stopBtn').addEventListener('click', () => {
            this.socket.emit('stopBot');
            this.disableButton('stopBtn');
            setTimeout(() => this.enableButton('stopBtn'), 2000);
        });

        document.getElementById('refreshBtn').addEventListener('click', () => {
            this.socket.emit('requestStatus');
            this.showRefreshAnimation();
        });
    }

    updateConnectionStatus(connected) {
        const statusBadge = document.getElementById('connectionStatus');
        const statusText = statusBadge.querySelector('.status-text');
        
        if (connected) {
            statusBadge.classList.remove('disconnected');
            statusBadge.classList.add('connected');
            statusText.textContent = 'Connected';
        } else {
            statusBadge.classList.remove('connected');
            statusBadge.classList.add('disconnected');
            statusText.textContent = 'Disconnected';
        }
    }

    updateDashboard(data) {
        // Update bot status
        this.botRunning = data.isRunning;
        this.updateBotStatus(data.isRunning);

        // Update stats
        if (data.stats) {
            this.updateStats(data.stats);
        }

        // Update system info
        if (data.systemInfo) {
            this.updateSystemInfo(data.systemInfo);
        }

        // Update liquidations
        if (data.recentLiquidations) {
            this.liquidations = data.recentLiquidations;
            this.renderLiquidations();
        }

        // Update opportunities
        if (data.opportunities) {
            this.opportunities = data.opportunities;
            this.renderOpportunities();
        }
    }

    updateBotStatus(isRunning) {
        const botStateElement = document.getElementById('botState');
        if (isRunning) {
            botStateElement.textContent = '🟢 Running';
            botStateElement.classList.add('text-success');
            botStateElement.classList.remove('text-danger');
        } else {
            botStateElement.textContent = '🔴 Stopped';
            botStateElement.classList.add('text-danger');
            botStateElement.classList.remove('text-success');
        }
    }

    updateStats(stats) {
        const totalProfitEl = document.getElementById('totalProfit');
        const liquidationCountEl = document.getElementById('liquidationCount');
        const walletBalanceEl = document.getElementById('walletBalance');
        const activeBorrowersEl = document.getElementById('activeBorrowers');

        if (stats.totalProfit !== undefined) {
            totalProfitEl.textContent = `${stats.totalProfit} BNB`;
            totalProfitEl.classList.add('stat-value');
        }

        if (stats.liquidationCount !== undefined) {
            liquidationCountEl.textContent = stats.liquidationCount;
            liquidationCountEl.classList.add('stat-value');
        }

        if (stats.walletBalance !== undefined) {
            walletBalanceEl.textContent = `${stats.walletBalance} BNB`;
            walletBalanceEl.classList.add('stat-value');
        }

        if (stats.activeBorrowers !== undefined) {
            activeBorrowersEl.textContent = stats.activeBorrowers;
            activeBorrowersEl.classList.add('stat-value');
        }
    }

    updateSystemInfo(info) {
        if (info.currentBlock) {
            document.getElementById('currentBlock').textContent = info.currentBlock.toLocaleString();
        }

        if (info.walletAddress) {
            document.getElementById('walletAddress').textContent = info.walletAddress;
        }

        if (info.minProfit) {
            document.getElementById('minProfit').textContent = `${info.minProfit} BNB`;
        }

        if (info.pollingInterval) {
            document.getElementById('pollingInterval').textContent = `${info.pollingInterval}s`;
        }
    }

    addLiquidation(liquidation) {
        this.liquidations.unshift(liquidation);
        if (this.liquidations.length > 20) {
            this.liquidations.pop();
        }
        this.renderLiquidations();
    }

    addOpportunity(opportunity) {
        // Check if opportunity already exists
        const exists = this.opportunities.some(opp => opp.borrower === opportunity.borrower);
        if (!exists) {
            this.opportunities.unshift(opportunity);
            this.renderOpportunities();
        }
    }

    removeOpportunity(borrower) {
        this.opportunities = this.opportunities.filter(opp => opp.borrower !== borrower);
        this.renderOpportunities();
    }

    renderLiquidations() {
        const container = document.getElementById('activityList');
        
        if (this.liquidations.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📊</div>
                    <p>No liquidations yet. Monitoring for opportunities...</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.liquidations.map(liq => `
            <div class="activity-item">
                <div class="activity-header">
                    <div class="activity-title">💎 Liquidation Success</div>
                    <div class="activity-time">${this.formatTime(liq.timestamp)}</div>
                </div>
                <div class="activity-details">
                    <div class="activity-detail">
                        <span class="detail-label">Borrower:</span>
                        <span class="detail-value monospace">${this.truncateAddress(liq.borrower)}</span>
                    </div>
                    <div class="activity-detail">
                        <span class="detail-label">Profit:</span>
                        <span class="detail-value profit-positive">${liq.profit}</span>
                    </div>
                    <div class="activity-detail">
                        <span class="detail-label">Repay Amount:</span>
                        <span class="detail-value">${liq.repayAmount}</span>
                    </div>
                    ${liq.txHash ? `
                    <div class="activity-detail">
                        <span class="detail-label">TX:</span>
                        <a href="https://bscscan.com/tx/${liq.txHash}" target="_blank" class="detail-value" style="color: var(--primary-color);">
                            ${this.truncateAddress(liq.txHash)}
                        </a>
                    </div>
                    ` : ''}
                </div>
            </div>
        `).join('');
    }

    renderOpportunities() {
        const container = document.getElementById('opportunitiesList');
        
        if (this.opportunities.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🔎</div>
                    <p>Scanning for liquidation opportunities...</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.opportunities.map(opp => `
            <div class="opportunity-item">
                <div class="activity-header">
                    <div class="activity-title">🎯 Potential Liquidation</div>
                    <div class="activity-time">Just now</div>
                </div>
                <div class="activity-details">
                    <div class="activity-detail">
                        <span class="detail-label">Borrower:</span>
                        <span class="detail-value monospace">${this.truncateAddress(opp.borrower)}</span>
                    </div>
                    <div class="activity-detail">
                        <span class="detail-label">Expected Profit:</span>
                        <span class="detail-value profit-positive">${opp.expectedProfit}</span>
                    </div>
                    <div class="activity-detail">
                        <span class="detail-label">Shortfall:</span>
                        <span class="detail-value">${opp.shortfall}</span>
                    </div>
                    <div class="activity-detail">
                        <span class="detail-label">Repay Amount:</span>
                        <span class="detail-value">${opp.repayAmount}</span>
                    </div>
                </div>
            </div>
        `).join('');
    }

    showToast(type, title, message) {
        const container = document.getElementById('toastContainer');
        const iconMap = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <div class="toast-icon">${iconMap[type]}</div>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'toastSlideIn 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    }

    disableButton(id) {
        const btn = document.getElementById(id);
        btn.disabled = true;
    }

    enableButton(id) {
        const btn = document.getElementById(id);
        btn.disabled = false;
    }

    showRefreshAnimation() {
        const btn = document.getElementById('refreshBtn');
        const icon = btn.querySelector('.btn-icon');
        icon.style.animation = 'spin 0.5s linear';
        setTimeout(() => {
            icon.style.animation = '';
        }, 500);
    }

    truncateAddress(address) {
        if (!address) return '-';
        if (address.length <= 13) return address;
        return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    }

    formatTime(timestamp) {
        if (!timestamp) return 'Just now';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        
        return date.toLocaleTimeString();
    }

    updateTimestamp() {
        // Update any relative timestamps
        const timeElements = document.querySelectorAll('.activity-time');
        timeElements.forEach(el => {
            const timestamp = el.dataset.timestamp;
            if (timestamp) {
                el.textContent = this.formatTime(parseInt(timestamp));
            }
        });
    }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new DashboardApp();
    window.dashboardApp = app; // Make it globally accessible for debugging
});
