// helpers/rpcManager.js
// UPDATED FOR LIQUIDATION BOT - Minor changes only

const { ethers } = require("ethers");

/**
 * Multi-RPC failover manager with automatic rotation and health tracking
 * Works for BOTH arbitrage and liquidation strategies
 */

const RPC_URLS = [
    process.env.BSC_RPC_QUICKNODE,
    process.env.BSC_RPC_NODEREAL,
    process.env.BSC_RPC_ANKR,
    process.env.BSC_RPC_PUBLIC,
    process.env.BSC_RPC_PUBLIC2,
    process.env.BSC_RPC_PUBLIC3
].filter(Boolean);

// Track RPC health
const rpcHealth = RPC_URLS.map(url => ({
    url,
    failures: 0,
    lastSuccess: Date.now(),
    consecutiveFailures: 0,
    // NEW: Track liquidation-specific metrics
    avgResponseTime: 0,
    totalRequests: 0
}));

let currentIndex = 0;
let provider = new ethers.JsonRpcProvider(RPC_URLS[currentIndex]);
let requestCount = 0;
let lastRotation = Date.now();

// Configuration
const ROTATION_INTERVAL = 100; // Rotate after 100 requests
const ROTATION_TIME = 5 * 60 * 1000; // Or every 5 minutes
const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 30000; // Check health every 30s

/**
 * Get the next healthy RPC endpoint
 */
function getNextHealthyIndex() {
    const startIndex = currentIndex;
    let attempts = 0;
    
    while (attempts < RPC_URLS.length) {
        currentIndex = (currentIndex + 1) % RPC_URLS.length;
        const health = rpcHealth[currentIndex];
        
        // Skip if too many consecutive failures
        if (health.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
            return currentIndex;
        }
        
        attempts++;
    }
    
    // If all RPCs are failing, reset counters and use first one
    console.warn('⚠️ All RPCs have failures, resetting health metrics');
    rpcHealth.forEach(h => {
        h.consecutiveFailures = 0;
        h.failures = 0;
    });
    currentIndex = 0;
    return currentIndex;
}

/**
 * Mark RPC as failed
 */
function markFailure(index) {
    rpcHealth[index].failures++;
    rpcHealth[index].consecutiveFailures++;
    console.warn(`⚠️ RPC ${index} (${RPC_URLS[index].substring(0, 30)}...) marked as failed`);
    console.warn(`   Total failures: ${rpcHealth[index].failures}, Consecutive: ${rpcHealth[index].consecutiveFailures}`);
}

/**
 * Mark RPC as successful
 * NEW: Track response time for liquidations (speed matters!)
 */
function markSuccess(index, responseTime = 0) {
    const health = rpcHealth[index];
    health.lastSuccess = Date.now();
    health.consecutiveFailures = 0;
    health.totalRequests++;
    
    // Calculate moving average response time
    if (responseTime > 0) {
        health.avgResponseTime = health.avgResponseTime === 0
            ? responseTime
            : (health.avgResponseTime * 0.9 + responseTime * 0.1);
    }
}

/**
 * Check if we should rotate to next RPC
 */
function shouldRotate() {
    const timeSinceRotation = Date.now() - lastRotation;
    
    // Rotate based on request count
    if (requestCount >= ROTATION_INTERVAL) {
        console.log(`🔄 Rotating RPC: Request count reached (${requestCount} requests)`);
        return true;
    }
    
    // Rotate based on time
    if (timeSinceRotation >= ROTATION_TIME) {
        console.log(`🔄 Rotating RPC: Time interval reached (${Math.floor(timeSinceRotation / 1000 / 60)} minutes)`);
        return true;
    }
    
    return false;
}

/**
 * Rotate to next RPC provider
 */
function rotateProvider() {
    const oldIndex = currentIndex;
    currentIndex = getNextHealthyIndex();
    
    if (oldIndex !== currentIndex) {
        provider = new ethers.JsonRpcProvider(RPC_URLS[currentIndex]);
        requestCount = 0;
        lastRotation = Date.now();
        
        console.log(`\n🔁 RPC ROTATED`);
        console.log(`   From: [${oldIndex}] ${RPC_URLS[oldIndex].substring(0, 40)}...`);
        console.log(`   To:   [${currentIndex}] ${RPC_URLS[currentIndex].substring(0, 40)}...`);
        console.log(`   Reason: Scheduled rotation\n`);
    }
    
    return provider;
}

/**
 * Get provider with automatic rotation and failover
 * NEW: Track response time for performance monitoring
 */
async function getProvider() {
    const startTime = Date.now();
    
    try {
        // Check if we should rotate to next RPC
        if (shouldRotate()) {
            rotateProvider();
        }
        
        // Test current provider connectivity
        const blockNumber = await Promise.race([
            provider.getBlockNumber(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('RPC timeout')), 5000)
            )
        ]);
        
        const responseTime = Date.now() - startTime;
        
        // Success - mark it and increment counter
        markSuccess(currentIndex, responseTime);
        requestCount++;
        
        return provider;
        
    } catch (err) {
        console.error(`❌ RPC [${currentIndex}] failed: ${err.message}`);
        markFailure(currentIndex);
        
        // Try next RPC
        const oldIndex = currentIndex;
        currentIndex = getNextHealthyIndex();
        provider = new ethers.JsonRpcProvider(RPC_URLS[currentIndex]);
        requestCount = 0;
        lastRotation = Date.now();
        
        console.log(`🔁 Switched to RPC [${currentIndex}] ${RPC_URLS[currentIndex].substring(0, 40)}...`);
        
        // Verify new provider works
        try {
            await provider.getBlockNumber();
            markSuccess(currentIndex);
            return provider;
        } catch (err2) {
            console.error(`❌ Backup RPC also failed: ${err2.message}`);
            markFailure(currentIndex);
            throw new Error('All RPCs failing');
        }
    }
}

/**
 * Get RPC health statistics
 * NEW: Include performance metrics for liquidation optimization
 */
function getRPCStats() {
    return {
        currentRPC: RPC_URLS[currentIndex],
        currentIndex,
        requestCount,
        timeSinceRotation: Math.floor((Date.now() - lastRotation) / 1000),
        health: rpcHealth.map((h, i) => ({
            index: i,
            url: h.url.substring(0, 40) + '...',
            failures: h.failures,
            consecutiveFailures: h.consecutiveFailures,
            lastSuccess: Math.floor((Date.now() - h.lastSuccess) / 1000) + 's ago',
            avgResponseTime: h.avgResponseTime > 0 ? `${h.avgResponseTime.toFixed(0)}ms` : 'N/A',
            totalRequests: h.totalRequests,
            isActive: i === currentIndex
        }))
    };
}

/**
 * NEW: Get fastest RPC (useful for time-sensitive liquidations)
 */
function getFastestRPC() {
    const rpcsWithData = rpcHealth.filter(h => h.avgResponseTime > 0);
    
    if (rpcsWithData.length === 0) {
        return currentIndex; // No data, stick with current
    }
    
    const fastest = rpcsWithData.reduce((best, current, idx) => {
        return current.avgResponseTime < rpcHealth[best].avgResponseTime ? idx : best;
    }, 0);
    
    return fastest;
}

/**
 * NEW: Switch to fastest RPC (for critical liquidations)
 */
function switchToFastest() {
    const fastestIndex = getFastestRPC();
    
    if (fastestIndex !== currentIndex) {
        console.log(`⚡ Switching to fastest RPC [${fastestIndex}] (${rpcHealth[fastestIndex].avgResponseTime.toFixed(0)}ms avg)`);
        currentIndex = fastestIndex;
        provider = new ethers.JsonRpcProvider(RPC_URLS[currentIndex]);
        requestCount = 0;
        lastRotation = Date.now();
    }
    
    return provider;
}

/**
 * Force rotation to next RPC (useful for testing)
 */
function forceRotation() {
    console.log('🔧 Force rotating RPC...');
    return rotateProvider();
}

/**
 * Reset health metrics for all RPCs
 */
function resetHealth() {
    rpcHealth.forEach(h => {
        h.failures = 0;
        h.consecutiveFailures = 0;
        h.lastSuccess = Date.now();
        h.avgResponseTime = 0;
        h.totalRequests = 0;
    });
    console.log('✅ RPC health metrics reset');
}

// Periodic health check
setInterval(() => {
    const stats = getRPCStats();
    console.log(`\n📊 RPC Health Check:`);
    console.log(`   Current: [${stats.currentIndex}] ${stats.currentRPC.substring(0, 50)}...`);
    console.log(`   Requests since rotation: ${stats.requestCount}/${ROTATION_INTERVAL}`);
    console.log(`   Time since rotation: ${stats.timeSinceRotation}s / ${ROTATION_TIME/1000}s`);
    
    const unhealthy = rpcHealth.filter(h => h.consecutiveFailures > 0);
    if (unhealthy.length > 0) {
        console.log(`   ⚠️ Unhealthy RPCs: ${unhealthy.length}/${RPC_URLS.length}`);
    }
    
    // Show fastest RPC
    const fastest = getFastestRPC();
    if (rpcHealth[fastest].avgResponseTime > 0) {
        console.log(`   ⚡ Fastest RPC: [${fastest}] (${rpcHealth[fastest].avgResponseTime.toFixed(0)}ms avg)`);
    }
}, HEALTH_CHECK_INTERVAL);

module.exports = { 
    getProvider, 
    getRPCStats, 
    forceRotation,
    resetHealth,
    switchToFastest,  // NEW: For time-sensitive liquidations
    getFastestRPC     // NEW: For performance monitoring
};
