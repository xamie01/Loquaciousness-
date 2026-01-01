/**
 * helpers/multicall.js
 * 
 * Multicall3 helper for batching multiple contract calls into a single RPC request
 * Reduces RPC calls from O(N) to O(1) per batch
 */

const { ethers } = require("ethers");

// Multicall3 is deployed at the same address on BSC and many EVM chains
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "target", "type": "address" },
                    { "internalType": "bytes", "name": "callData", "type": "bytes" }
                ],
                "internalType": "struct Multicall3.Call[]",
                "name": "calls",
                "type": "tuple[]"
            }
        ],
        "name": "aggregate",
        "outputs": [
            { "internalType": "uint256", "name": "blockNumber", "type": "uint256" },
            { "internalType": "bytes[]", "name": "returnData", "type": "bytes[]" }
        ],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "components": [
                    { "internalType": "address", "name": "target", "type": "address" },
                    { "internalType": "bool", "name": "allowFailure", "type": "bool" },
                    { "internalType": "bytes", "name": "callData", "type": "bytes" }
                ],
                "internalType": "struct Multicall3.Call3[]",
                "name": "calls",
                "type": "tuple[]"
            }
        ],
        "name": "aggregate3",
        "outputs": [
            {
                "components": [
                    { "internalType": "bool", "name": "success", "type": "bool" },
                    { "internalType": "bytes", "name": "returnData", "type": "bytes" }
                ],
                "internalType": "struct Multicall3.Result[]",
                "name": "returnData",
                "type": "tuple[]"
            }
        ],
        "stateMutability": "payable",
        "type": "function"
    }
];

class MulticallHelper {
    constructor(provider) {
        this.provider = provider;
        this.multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    }

    /**
     * Batch multiple contract calls into a single RPC request
     * @param {Array} calls - Array of { target: address, callData: bytes, allowFailure: bool }
     * @returns {Array} Array of { success: bool, returnData: bytes }
     */
    async batchCall(calls) {
        try {
            const multicallCalls = calls.map(call => ({
                target: call.target,
                allowFailure: call.allowFailure !== undefined ? call.allowFailure : true,
                callData: call.callData
            }));

            const results = await this.multicall.aggregate3(multicallCalls);
            return results;
        } catch (error) {
            console.error('Multicall batch failed:', error.message);
            throw error;
        }
    }

    /**
     * Batch check borrow balances for multiple borrowers across multiple vTokens
     * @param {Array} borrowers - Array of borrower addresses
     * @param {Array} vTokens - Array of { address, abi } objects
     * @returns {Object} Map of borrower -> vToken -> balance
     */
    async getBorrowBalances(borrowers, vTokens) {
        const calls = [];
        const vTokenInterface = new ethers.Interface([
            "function borrowBalanceStored(address account) external view returns (uint)"
        ]);

        // Create a call for each borrower x vToken combination
        for (const borrower of borrowers) {
            for (const vToken of vTokens) {
                calls.push({
                    target: vToken.address,
                    allowFailure: true,
                    callData: vTokenInterface.encodeFunctionData("borrowBalanceStored", [borrower]),
                    borrower: borrower,
                    vToken: vToken.address,
                    symbol: vToken.symbol
                });
            }
        }

        const results = await this.batchCall(calls);
        
        // Parse results into a structured map
        const balances = {};
        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            const result = results[i];
            
            if (!balances[call.borrower]) {
                balances[call.borrower] = {};
            }
            
            if (result.success) {
                try {
                    const decoded = vTokenInterface.decodeFunctionResult(
                        "borrowBalanceStored",
                        result.returnData
                    );
                    balances[call.borrower][call.vToken] = {
                        balance: decoded[0],
                        symbol: call.symbol
                    };
                } catch (error) {
                    // Failed to decode, set to 0
                    balances[call.borrower][call.vToken] = {
                        balance: 0n,
                        symbol: call.symbol
                    };
                }
            } else {
                // Call failed, set to 0
                balances[call.borrower][call.vToken] = {
                    balance: 0n,
                    symbol: call.symbol
                };
            }
        }

        return balances;
    }

    /**
     * Batch get oracle prices for multiple vTokens
     * @param {Object} oracle - Oracle contract instance
     * @param {Array} vTokenAddresses - Array of vToken addresses
     * @returns {Object} Map of vToken -> price
     */
    async getOraclePrices(oracle, vTokenAddresses) {
        const calls = [];
        const oracleInterface = new ethers.Interface([
            "function getUnderlyingPrice(address vToken) external view returns (uint)"
        ]);

        for (const vTokenAddress of vTokenAddresses) {
            calls.push({
                target: await oracle.getAddress(),
                allowFailure: true,
                callData: oracleInterface.encodeFunctionData("getUnderlyingPrice", [vTokenAddress]),
                vToken: vTokenAddress
            });
        }

        const results = await this.batchCall(calls);
        
        const prices = {};
        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            const result = results[i];
            
            if (result.success) {
                try {
                    const decoded = oracleInterface.decodeFunctionResult(
                        "getUnderlyingPrice",
                        result.returnData
                    );
                    prices[call.vToken] = decoded[0];
                } catch (error) {
                    prices[call.vToken] = 0n;
                }
            } else {
                prices[call.vToken] = 0n;
            }
        }

        return prices;
    }

    /**
     * Check which borrowers have non-zero borrow balances
     * Returns only borrowers with active borrows (for pruning)
     * @param {Array} borrowers - Array of borrower addresses
     * @param {Array} vTokens - Array of vToken addresses
     * @returns {Set} Set of borrowers with non-zero balances
     */
    async getActiveBorrowers(borrowers, vTokens) {
        const balances = await this.getBorrowBalances(
            borrowers,
            vTokens.map((addr, idx) => ({ address: addr, symbol: `vToken${idx}` }))
        );

        const activeBorrowers = new Set();
        
        for (const [borrower, vTokenBalances] of Object.entries(balances)) {
            // Check if borrower has any non-zero balance
            const hasBalance = Object.values(vTokenBalances).some(
                tokenData => tokenData.balance > 0n
            );
            
            if (hasBalance) {
                activeBorrowers.add(borrower);
            }
        }

        return activeBorrowers;
    }
}

module.exports = MulticallHelper;
