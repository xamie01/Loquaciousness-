// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";

/**
 * @title BSC LiquidationV3
 * @notice Flash loan liquidation bot for Venus Protocol on BSC
 * @dev Uses PancakeSwap V3 flash swaps (0% fees!)
 */
contract BSC_LiquidationV3 is IUniswapV3FlashCallback {
    
    // ============================================
    // STATE VARIABLES
    // ============================================
    
    address public immutable owner;
    address public immutable pancakeV3Factory;
    address public immutable pancakeV3Router;
    address public immutable venusComptroller;
    
    // PancakeSwap V3 Factory on BSC
    address public constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    
    // Venus Protocol on BSC
    address public constant VENUS_COMPTROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    
    // ============================================
    // STRUCTS
    // ============================================
    
    struct FlashCallbackData {
        address borrower;           // Address to liquidate
        address debtToken;          // Token borrowed (to repay)
        address collateralToken;    // Token received as collateral
        address vDebtToken;         // Venus debt token (vToken)
        address vCollateralToken;   // Venus collateral token (vToken)
        uint256 repayAmount;        // Amount to repay
        uint24 swapFee;            // Fee tier for DEX swap
        address payer;
    }
    
    // ============================================
    // EVENTS
    // ============================================
    
    event LiquidationExecuted(
        address indexed borrower,
        address indexed debtToken,
        address indexed collateralToken,
        uint256 repayAmount,
        uint256 profit
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
        address _pancakeV3Router,
        address _pancakeV3Factory,
        address _venusComptroller
    ) {
        require(_pancakeV3Router != address(0), "Invalid V3 router");
        require(_pancakeV3Factory != address(0), "Invalid V3 factory");
        require(_venusComptroller != address(0), "Invalid comptroller");
        
        owner = msg.sender;
        pancakeV3Router = _pancakeV3Router;
        pancakeV3Factory = _pancakeV3Factory;
        venusComptroller = _venusComptroller;
    }
    
    // ============================================
    // MAIN EXECUTION FUNCTION
    // ============================================
    
    /**
     * @notice Execute liquidation using flash loan
     * @param borrower Address of the underwater borrower
     * @param debtToken Token borrowed by user
     * @param collateralToken Token to seize as collateral
     * @param vDebtToken Venus vToken for debt
     * @param vCollateralToken Venus vToken for collateral
     * @param repayAmount Amount of debt to repay
     * @param swapFee Fee tier for PancakeSwap (500, 2500, 10000)
     */
    function executeLiquidation(
        address borrower,
        address debtToken,
        address collateralToken,
        address vDebtToken,
        address vCollateralToken,
        uint256 repayAmount,
        uint24 swapFee
    ) external onlyOwner {
        require(borrower != address(0), "Invalid borrower");
        require(debtToken != address(0), "Invalid debt token");
        require(collateralToken != address(0), "Invalid collateral token");
        require(repayAmount > 0, "Invalid repay amount");
        
        // Get V3 pool for flash loan
        address poolAddress = _getV3Pool(debtToken, collateralToken, swapFee);
        require(poolAddress != address(0), "Pool does not exist");
        
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddress);
        
        // Determine which token to borrow
        // Flash loan the debt token to repay the loan
        (uint256 amount0, uint256 amount1) = debtToken < collateralToken
            ? (repayAmount, uint256(0))
            : (uint256(0), repayAmount);
        
        // Prepare callback data
        bytes memory data = abi.encode(
            FlashCallbackData({
                borrower: borrower,
                debtToken: debtToken,
                collateralToken: collateralToken,
                vDebtToken: vDebtToken,
                vCollateralToken: vCollateralToken,
                repayAmount: repayAmount,
                swapFee: swapFee,
                payer: address(this)
            })
        );
        
        emit FlashLoanInitiated(poolAddress, amount0, amount1);
        
        // Initiate flash swap (0% fee on PancakeSwap V3!)
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
        address poolAddress = _getV3Pool(decoded.debtToken, decoded.collateralToken, decoded.swapFee);
        require(msg.sender == poolAddress, "Unauthorized callback");
        
        // Calculate amount to repay (borrowed amount + fees)
        // NOTE: PancakeSwap V3 flash has 0 fees!
        uint256 amountToRepay = decoded.repayAmount + fee0 + fee1;
        
        // Execute liquidation
        uint256 finalAmount = _executeLiquidation(
            decoded.borrower,
            decoded.debtToken,
            decoded.collateralToken,
            decoded.vDebtToken,
            decoded.vCollateralToken,
            decoded.repayAmount,
            decoded.swapFee
        );
        
        // Ensure we have enough to repay the flash loan
        require(finalAmount >= amountToRepay, "Liquidation not profitable");
        
        // Repay the flash loan
        TransferHelper.safeTransfer(decoded.debtToken, msg.sender, amountToRepay);
        
        // Calculate and transfer profit to owner
        uint256 profit = finalAmount - amountToRepay;
        if (profit > 0) {
            TransferHelper.safeTransfer(decoded.debtToken, owner, profit);
        }
        
        emit LiquidationExecuted(
            decoded.borrower,
            decoded.debtToken,
            decoded.collateralToken,
            decoded.repayAmount,
            profit
        );
    }
    
    // ============================================
    // INTERNAL LIQUIDATION FUNCTION
    // ============================================
    
    /**
     * @notice Execute the liquidation and swap collateral back to debt token
     * @return finalAmount Amount of debt token after all operations
     */
    function _executeLiquidation(
        address borrower,
        address debtToken,
        address collateralToken,
        address vDebtToken,
        address vCollateralToken,
        uint256 repayAmount,
        uint24 swapFee
    ) internal returns (uint256 finalAmount) {
        // Step 1: Approve Venus vToken to spend debt token
        TransferHelper.safeApprove(debtToken, vDebtToken, repayAmount);
        
        // Step 2: Liquidate the underwater position on Venus
        // Venus liquidateBorrow function signature:
        // liquidateBorrow(address borrower, uint repayAmount, VTokenInterface vTokenCollateral)
        
        // Call Venus liquidation
        (bool success, bytes memory result) = vDebtToken.call(
            abi.encodeWithSignature(
                "liquidateBorrow(address,uint256,address)",
                borrower,
                repayAmount,
                vCollateralToken
            )
        );
        require(success, "Venus liquidation failed");
        
        // Step 3: Redeem seized collateral from Venus
        // First, check how much vCollateral we received
        uint256 vCollateralBalance = IERC20(vCollateralToken).balanceOf(address(this));
        require(vCollateralBalance > 0, "No collateral received");
        
        // Redeem vTokens for underlying collateral
        (success, ) = vCollateralToken.call(
            abi.encodeWithSignature("redeem(uint256)", vCollateralBalance)
        );
        require(success, "Collateral redemption failed");
        
        // Step 4: Get collateral balance
        uint256 collateralBalance = IERC20(collateralToken).balanceOf(address(this));
        require(collateralBalance > 0, "No collateral after redeem");
        
        // Step 5: Swap collateral back to debt token on PancakeSwap V3
        finalAmount = _swapOnV3(
            collateralToken,
            debtToken,
            swapFee,
            collateralBalance,
            0 // No minimum for now - in production, calculate this
        );
    }
    
    // ============================================
    // SWAP FUNCTION
    // ============================================
    
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
