// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";

interface IWBNB {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * @title BSC LiquidationV3
 * @notice Flash-swap based liquidation executor for Venus on BSC
 * @dev Uses PancakeSwap V3 flash swaps (0% fee) to source repay capital.
 *      Protects against pool ordering issues and enforces a minimum output to avoid slippage losses.
 */
contract BSC_LiquidationV3 is IUniswapV3FlashCallback, ReentrancyGuard, Pausable {
    address public immutable owner;
    address public immutable pancakeV3Factory;
    address public immutable pancakeV3Router;
    address public immutable venusComptroller; // for reference, not directly used here

    // Core BSC addresses
    address public constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address public constant VENUS_COMPTROLLER = 0xfD36E2c2a6789Db23113685031d7F16329158384;
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    struct FlashCallbackData {
        address borrower;
        address debtToken;          // original debt token (may be native via zero address)
        address collateralToken;    // original collateral token (may be native via zero address)
        address vDebtToken;
        address vCollateralToken;
        uint256 repayAmount;
        uint24 swapFee;
        bool debtIsNative;
        bool collateralIsNative;
        uint24 minOutBps;
    }

    event LiquidationExecuted(
        address indexed borrower,
        address indexed debtToken,
        address indexed collateralToken,
        uint256 repayAmount,
        uint256 profit
    );
    
    event EmergencyWithdraw(
        address indexed token,
        uint256 amount,
        address indexed to
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

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

    /**
     * @notice Execute liquidation using a Pancake V3 flash swap.
     * @dev Repays in the debt token, seizes collateral, swaps back to debt token, repays flash, keeps surplus.
     * @param borrower Address to liquidate
     * @param debtToken Debt token (use address(0) for BNB/vBNB)
     * @param collateralToken Collateral token (use address(0) for BNB/vBNB)
     * @param vDebtToken Venus vToken for debt
     * @param vCollateralToken Venus vToken for collateral
     * @param repayAmount Amount of debt to repay (and flash-borrow)
     * @param swapFee V3 fee tier (500, 2500, 10000)
     * @param minOutBps Minimum output buffer in basis points above repay (e.g., 100 = +1%)
     */
    function executeLiquidation(
        address borrower,
        address debtToken,
        address collateralToken,
        address vDebtToken,
        address vCollateralToken,
        uint256 repayAmount,
        uint24 swapFee,
        uint24 minOutBps
    ) external onlyOwner nonReentrant whenNotPaused {
        require(borrower != address(0), "Invalid borrower");
        require(repayAmount > 0, "Invalid repay amount");
        require(minOutBps <= 5000, "minOut too high");

        bool debtIsNative = (debtToken == address(0));
        bool collateralIsNative = (collateralToken == address(0));

        address borrowToken = debtIsNative ? WBNB : debtToken;
        address poolAddress = _getV3Pool(borrowToken, collateralIsNative ? WBNB : collateralToken, swapFee);
        require(poolAddress != address(0), "Pool does not exist");

        IUniswapV3Pool pool = IUniswapV3Pool(poolAddress);

        (address tokenA, address tokenB) = borrowToken < (collateralIsNative ? WBNB : collateralToken)
            ? (borrowToken, collateralIsNative ? WBNB : collateralToken)
            : ((collateralIsNative ? WBNB : collateralToken), borrowToken);
        bool borrowIsToken0 = (borrowToken == tokenA);
        uint256 amount0 = borrowIsToken0 ? repayAmount : 0;
        uint256 amount1 = borrowIsToken0 ? 0 : repayAmount;

        bytes memory data = abi.encode(
            FlashCallbackData({
                borrower: borrower,
                debtToken: borrowToken, // stored as ERC20 (WBNB if native)
                collateralToken: collateralIsNative ? WBNB : collateralToken,
                vDebtToken: vDebtToken,
                vCollateralToken: vCollateralToken,
                repayAmount: repayAmount,
                swapFee: swapFee,
                debtIsNative: debtIsNative,
                collateralIsNative: collateralIsNative,
                minOutBps: minOutBps
            })
        );

        pool.flash(address(this), amount0, amount1, data);
    }

    /**
     * @notice Pancake V3 flash callback
     */
    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override {
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));

        address poolAddress = _getV3Pool(decoded.debtToken, decoded.collateralToken, decoded.swapFee);
        require(msg.sender == poolAddress, "Unauthorized callback");

        // Determine which side was borrowed
        bool borrowedToken0 = decoded.debtToken < decoded.collateralToken;
        uint256 amountToRepay = borrowedToken0 ? decoded.repayAmount + fee0 : decoded.repayAmount + fee1;
        address repayToken = decoded.debtToken; // always ERC20 (WBNB or debt)

        uint256 minOut = amountToRepay + ((amountToRepay * decoded.minOutBps) / 10000);
        uint256 amountReceived = _executeLiquidation(decoded, repayToken, minOut);

        require(amountReceived >= amountToRepay, "Not profitable");

        // Repay flash loan
        TransferHelper.safeTransfer(repayToken, msg.sender, amountToRepay);

        uint256 profit = amountReceived - amountToRepay;
        if (profit > 0) {
            TransferHelper.safeTransfer(repayToken, owner, profit);
        }

        emit LiquidationExecuted(
            decoded.borrower,
            decoded.debtIsNative ? address(0) : decoded.debtToken,
            decoded.collateralIsNative ? address(0) : decoded.collateralToken,
            decoded.repayAmount,
            profit
        );
    }

    function _executeLiquidation(
        FlashCallbackData memory decoded,
        address repayToken,
        uint256 minOut
    ) internal returns (uint256 finalAmount) {
        // If debt is native, unwrap WBNB to BNB for repay
        if (decoded.debtIsNative) {
            IWBNB(repayToken).withdraw(decoded.repayAmount);
            (bool ok, ) = decoded.vDebtToken.call{value: decoded.repayAmount}(
                abi.encodeWithSignature(
                    "liquidateBorrow(address,uint256,address)",
                    decoded.borrower,
                    decoded.repayAmount,
                    decoded.vCollateralToken
                )
            );
            require(ok, "Liquidation failed (BNB)");
        } else {
            // Approve debt token to vDebtToken
            TransferHelper.safeApprove(repayToken, decoded.vDebtToken, 0);
            TransferHelper.safeApprove(repayToken, decoded.vDebtToken, decoded.repayAmount);
            (bool ok, ) = decoded.vDebtToken.call(
                abi.encodeWithSignature(
                    "liquidateBorrow(address,uint256,address)",
                    decoded.borrower,
                    decoded.repayAmount,
                    decoded.vCollateralToken
                )
            );
            require(ok, "Liquidation failed");
        }

        // Redeem seized collateral (vTokens)
        uint256 vBal = IERC20(decoded.vCollateralToken).balanceOf(address(this));
        require(vBal > 0, "No collateral received");
        (bool redeemOk, ) = decoded.vCollateralToken.call(abi.encodeWithSignature("redeem(uint256)", vBal));
        require(redeemOk, "Redeem failed");

        address collateralToken = decoded.collateralToken;
        uint256 collateralBal;

        if (decoded.collateralIsNative) {
            collateralBal = address(this).balance;
            require(collateralBal > 0, "No BNB collateral");
            IWBNB(WBNB).deposit{value: collateralBal}();
            collateralToken = WBNB;
        } else {
            collateralBal = IERC20(collateralToken).balanceOf(address(this));
            require(collateralBal > 0, "No collateral after redeem");
        }

        // Swap collateral -> repay token on V3 with minOut = amountToRepay guard
        finalAmount = _swapOnV3(
            collateralToken,
            repayToken,
            decoded.swapFee,
            collateralBal,
            minOut
        );
    }

    function _swapOnV3(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) internal returns (uint256 amountOut) {
        TransferHelper.safeApprove(tokenIn, pancakeV3Router, 0);
        TransferHelper.safeApprove(tokenIn, pancakeV3Router, amountIn);

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

        amountOut = ISwapRouter(pancakeV3Router).exactInputSingle(params);
    }

    function _getV3Pool(
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (address pool) {
        (address tokenA, address tokenB) = token0 < token1 ? (token0, token1) : (token1, token0);
        pool = address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff",
            pancakeV3Factory,
            keccak256(abi.encode(tokenA, tokenB, fee)),
            hex"6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2"
        )))));
    }

    /**
     * @notice Pause liquidation operations in case of emergency
     * @dev Can only be called by owner
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause liquidation operations
     * @dev Can only be called by owner
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency withdraw function to rescue stuck funds
     * @dev Can only be called by owner. Use address(0) for native BNB
     * @param token Address of the token to withdraw (address(0) for BNB)
     * @param amount Amount to withdraw (0 = withdraw all)
     * @dev This function uses nonReentrant modifier for additional safety
     *      even though owner is immutable and trusted
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        uint256 withdrawAmount;
        
        if (token == address(0)) {
            // Withdraw BNB - uses nonReentrant for consistency
            withdrawAmount = (amount == 0) ? address(this).balance : amount;
            require(withdrawAmount > 0, "No BNB to withdraw");
            (bool success, ) = owner.call{value: withdrawAmount}("");
            require(success, "BNB transfer failed");
        } else {
            // Withdraw ERC20 token
            IERC20 tokenContract = IERC20(token);
            uint256 balance = tokenContract.balanceOf(address(this));
            withdrawAmount = (amount == 0) ? balance : amount;
            require(withdrawAmount > 0, "No tokens to withdraw");
            require(balance >= withdrawAmount, "Insufficient balance");
            TransferHelper.safeTransfer(token, owner, withdrawAmount);
        }
        
        emit EmergencyWithdraw(token, withdrawAmount, owner);
    }

    receive() external payable {}
}
