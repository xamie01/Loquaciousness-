require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.24",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            },
            viaIR: true,
        }
    },
    networks: {
        // BSC Mainnet
        bsc: {
            url: process.env.BSC_RPC_QUICKNODE || process.env.BSC_RPC_PUBLIC || "https://bsc-dataseed.binance.org/",
            chainId: 56,
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            gasPrice: 50000000, // 3 gwei (BSC standard)
            timeout: 80000
        },
        
        // BSC Testnet (for testing)
        bscTestnet: {
            url: "https://data-seed-prebsc-1-s1.binance.org:8545/",
            chainId: 97,
            accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
            gasPrice: 10000000000
        }
    },
    
    // BscScan verification
    etherscan: {
        apiKey: {
            bsc: process.env.BSCSCAN_API_KEY || "",
            bscTestnet: process.env.BSCSCAN_API_KEY || ""
        }
    },
    
    // Mocha timeout for tests
    mocha: {
        timeout: 200000
    }
};
