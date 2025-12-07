// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";

/**
 * @title BSC ArbitrageV3
 * @notice Flash loan arbitrage between PancakeSwap V2 and V3 on BSC
 * @dev Uses PancakeSwap V3 flash swaps (0% fees!)
 */
contract BSC_ArbitrageV3 is IUniswapV3FlashCallback {
    
    // ============================================
    // STATE VARIABLES
    // ============================================
    
    address public immutable owner;
    address public immutable pancakeV3Factory;
    address public immutable pancakeV2Router;
    address public immutable pancakeV3Router;
    
    // PancakeSwap V3 Factory on BSC
    address public constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    
    // ============================================
    // STRUCTS
    // ============================================
    
    struct FlashCallbackData {
        address token0;
        address token1;
        uint24 fee;
        uint256 amount0;
        uint256 amount1;
        bool startOnV3;
        uint256 amountOutMinimum;
        address payer;
    }
    
    // ============================================
    // EVENTS
    // ============================================
    
    event ArbitrageExecuted(
        address indexed token0,
        address indexed token1,
        uint256 profit,
        bool startOnV3
    );
    
    event FlashLoanInitiated(
        address indexed pool,
        uint256 amount0,
        uint256 amount1
    );
    
    // ============================================
    // MODIFIERS
    // ============================================
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }
    
    // ============================================
    // CONSTRUCTOR
    // ============================================
    
    constructor(
        address _pancakeV2Router,
        address _pancakeV3Router,
        address _pancakeV3Factory
    ) {
        require(_pancakeV2Router != address(0), "Invalid V2 router");
        require(_pancakeV3Router != address(0), "Invalid V3 router");
        require(_pancakeV3Factory != address(0), "Invalid V3 factory");
        
        owner = msg.sender;
        pancakeV2Router = _pancakeV2Router;
        pancakeV3Router = _pancakeV3Router;
        pancakeV3Factory = _pancakeV3Factory;
    }
    
    // ============================================
    // MAIN EXECUTION FUNCTION
    // ============================================
    
    /**
     * @notice Execute arbitrage trade using flash loan
     * @param startOnV3 True if buying on V3 first, false if V2 first
     * @param token0 First token address
     * @param token1 Second token address
     * @param fee Fee tier for V3 pool (500, 2500, 10000)
     * @param flashAmount Amount to flash loan
     * @param amountOutMinimum Minimum amount to receive (slippage protection)
     */
    function executeTrade(
        bool startOnV3,
        address token0,
        address token1,
        uint24 fee,
        uint256 flashAmount,
        uint256 amountOutMinimum
    ) external onlyOwner {
        require(token0 != address(0) && token1 != address(0), "Invalid tokens");
        require(flashAmount > 0, "Invalid flash amount");
        
        // Get V3 pool for flash loan
        address poolAddress = _getV3Pool(token0, token1, fee);
        require(poolAddress != address(0), "Pool does not exist");
        
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddress);
        
        // Determine which token to borrow (always borrow token0 for simplicity)
        uint256 amount0 = flashAmount;
        uint256 amount1 = 0;
        
        // Prepare callback data
        bytes memory data = abi.encode(
            FlashCallbackData({
                token0: token0,
                token1: token1,
                fee: fee,
                amount0: amount0,
                amount1: amount1,
                startOnV3: startOnV3,
                amountOutMinimum: amountOutMinimum,
                payer: address(this)
            })
        );
        
        emit FlashLoanInitiated(poolAddress, amount0, amount1);
        
        // Initiate flash swap (0% fee!)
        pool.flash(address(this), amount0, amount1, data);
    }
    
    // ============================================
    // FLASH CALLBACK IMPLEMENTATION
    // ============================================
    
    /**
     * @notice Callback function called by PancakeSwap V3 pool after flash loan
     * @param fee0 Fee for token0 (always 0 on PancakeSwap V3)
     * @param fee1 Fee for token1 (always 0 on PancakeSwap V3)
     * @param data Encoded FlashCallbackData
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        // Decode callback data
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));
        
        // Verify caller is the V3 pool
        address poolAddress = _getV3Pool(decoded.token0, decoded.token1, decoded.fee);
        require(msg.sender == poolAddress, "Unauthorized callback");
        
        // Calculate amount to repay (borrowed amount + fees)
        // NOTE: PancakeSwap V3 flash has 0 fees!
        uint256 amountToRepay = decoded.amount0 + fee0;
        
        // Execute arbitrage swaps
        uint256 finalAmount = _executeArbitrageSwaps(
            decoded.token0,
            decoded.token1,
            decoded.fee,
            decoded.amount0,
            decoded.startOnV3,
            decoded.amountOutMinimum
        );
        
        // Ensure we have enough to repay the flash loan
        require(finalAmount >= amountToRepay, "Arbitrage not profitable");
        
        // Repay the flash loan
        TransferHelper.safeTransfer(decoded.token0, msg.sender, amountToRepay);
        
        // Calculate and transfer profit to owner
        uint256 profit = finalAmount - amountToRepay;
        if (profit > 0) {
            TransferHelper.safeTransfer(decoded.token0, owner, profit);
        }
        
        emit ArbitrageExecuted(decoded.token0, decoded.token1, profit, decoded.startOnV3);
    }
    
    // ============================================
    // INTERNAL SWAP FUNCTIONS
    // ============================================
    
    /**
     * @notice Execute the two swaps for arbitrage
     * @return finalAmount Amount received after both swaps
     */
    function _executeArbitrageSwaps(
        address token0,
        address token1,
        uint24 fee,
        uint256 flashAmount,
        bool startOnV3,
        uint256 amountOutMinimum
    ) internal returns (uint256 finalAmount) {
        if (startOnV3) {
            // Buy on V3, sell on V2
            uint256 amountAfterV3 = _swapOnV3(token0, token1, fee, flashAmount, 0);
            finalAmount = _swapOnV2(token1, token0, amountAfterV3, amountOutMinimum);
        } else {
            // Buy on V2, sell on V3
            uint256 amountAfterV2 = _swapOnV2(token0, token1, flashAmount, 0);
            finalAmount = _swapOnV3(token1, token0, fee, amountAfterV2, amountOutMinimum);
        }
    }
    
    /**
     * @notice Swap tokens on PancakeSwap V3
     */
    function _swapOnV3(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amountOut) {
        // Approve V3 router
        TransferHelper.safeApprove(tokenIn, pancakeV3Router, amountIn);
        
        // Set up swap parameters
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: 0
        });
        
        // Execute swap
        amountOut = ISwapRouter(pancakeV3Router).exactInputSingle(params);
    }
    
    /**
     * @notice Swap tokens on PancakeSwap V2
     */
    function _swapOnV2(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amountOut) {
        // Approve V2 router
        TransferHelper.safeApprove(tokenIn, pancakeV2Router, amountIn);
        
        // Set up swap path
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        // Execute swap
        uint256[] memory amounts = IPancakeRouter02(pancakeV2Router).swapExactTokensForTokens(
            amountIn,
            amountOutMinimum,
            path,
            address(this),
            block.timestamp
        );
        
        amountOut = amounts[amounts.length - 1];
    }
    
    // ============================================
    // HELPER FUNCTIONS
    // ============================================
    
    /**
     * @notice Get V3 pool address for token pair and fee
     */
    function _getV3Pool(
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (address pool) {
        // Sort tokens
        (address tokenA, address tokenB) = token0 < token1 ? (token0, token1) : (token1, token0);
        
        // Compute pool address
        pool = address(uint160(uint256(keccak256(abi.encodePacked(
            hex'ff',
            pancakeV3Factory,
            keccak256(abi.encode(tokenA, tokenB, fee)),
            hex'6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2' // PancakeSwap V3 POOL_INIT_CODE_HASH
        )))));
    }
    
    /**
     * @notice Emergency withdrawal function
     */
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        TransferHelper.safeTransfer(token, owner, amount);
    }
    
    /**
     * @notice Withdraw BNB
     */
    function withdrawBNB() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }
    
    // Receive BNB
    receive() external payable {}
}

/**
 * @notice PancakeSwap V2 Router Interface
 */
interface IPancakeRouter02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
