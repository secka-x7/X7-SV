// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// X7 PROTOCOL — DYNAMIC FEE CONTRACT
// Fee structure rises with position severity:
//   HF > 0.95:       1%  fee (barely liquidatable)
//   HF 0.85-0.95:    5%  fee (clearly liquidatable)
//   HF 0.70-0.85:   15%  fee (deeply underwater)
//   HF 0.50-0.70:   30%  fee (severely distressed)
//   HF < 0.50:      50%  fee (catastrophically underwater)
// Higher distress = higher extraction = more revenue

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IAavePool {
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external;
    function liquidationCall(address, address, address, uint256, bool) external;
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
}

interface ICompound {
    function isLiquidatable(address) external view returns (bool);
    function absorb(address, address[] calldata) external;
    function buyCollateral(address, uint256, uint256, address) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata)
        external payable returns (uint256);
}

contract X7 {
    address public immutable owner;
    address public immutable aavePool;
    address public immutable router;
    address public immutable usdc;
    uint256 private _lock = 1;

    // Fee basis points by health factor tier
    // Applied to gross liquidation profit
    uint256 public constant FEE_TIER_0 = 100;   // HF > 0.95  → 1%
    uint256 public constant FEE_TIER_1 = 500;   // HF 0.85-0.95 → 5%
    uint256 public constant FEE_TIER_2 = 1500;  // HF 0.70-0.85 → 15%
    uint256 public constant FEE_TIER_3 = 3000;  // HF 0.50-0.70 → 30%
    uint256 public constant FEE_TIER_4 = 5000;  // HF < 0.50   → 50%
    uint256 public constant BPS        = 10000;

    // Fee accumulator — tracks protocol fees collected
    uint256 public totalFeesCollected;
    uint256 public totalLiquidations;

    modifier nonReentrant() {
        require(_lock == 1, "X7:reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "X7:auth");
        _;
    }

    constructor(address _aavePool, address _router, address _usdc) {
        owner    = msg.sender;
        aavePool = _aavePool;
        router   = _router;
        usdc     = _usdc;
    }

    // Calculate dynamic fee based on health factor
    // healthFactor is in 1e18 units (1.0 HF = 1e18)
    function getDynamicFee(uint256 healthFactor) public pure returns (uint256) {
        // HF < 0.50 (5e17) — catastrophic — 50% fee
        if (healthFactor < 5e17) return FEE_TIER_4;
        // HF 0.50-0.70 (5e17 to 7e17) — severe — 30% fee
        if (healthFactor < 7e17) return FEE_TIER_3;
        // HF 0.70-0.85 (7e17 to 85e16) — deep — 15% fee
        if (healthFactor < 85e16) return FEE_TIER_2;
        // HF 0.85-0.95 (85e16 to 95e16) — clear — 5% fee
        if (healthFactor < 95e16) return FEE_TIER_1;
        // HF > 0.95 — barely liquidatable — 1% fee
        return FEE_TIER_0;
    }

    // AAVE V3 LIQUIDATION
    function aaveLiquidate(
        address debtAsset,
        uint256 debtAmount,
        address collateral,
        address borrower,
        uint24  swapFee
    ) external nonReentrant onlyOwner {
        // Get health factor BEFORE liquidation for dynamic fee
        (, , , , , uint256 hf) = IAavePool(aavePool).getUserAccountData(borrower);
        bytes memory params = abi.encode(collateral, borrower, swapFee, hf, uint8(0));
        IAavePool(aavePool).flashLoanSimple(address(this), debtAsset, debtAmount, params, 0);
    }

    // Aave flash loan callback
    function executeOperation(
        address  asset,
        uint256  amount,
        uint256  premium,
        address  initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool && initiator == address(this), "X7:bad");

        (address collateral, address borrower, uint24 swapFee, uint256 healthFactor,) =
            abi.decode(params, (address, address, uint24, uint256, uint8));

        // Repay approval
        IERC20(asset).approve(aavePool, amount + premium);

        // Execute liquidation — get collateral bonus
        IAavePool(aavePool).liquidationCall(
            collateral, asset, borrower, type(uint256).max, false
        );

        // Swap collateral to USDC
        uint256 collBal = IERC20(collateral).balanceOf(address(this));
        uint256 usdcReceived = 0;
        if (collateral != usdc && collBal > 0) {
            IERC20(collateral).approve(router, collBal);
            usdcReceived = ISwapRouter(router).exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn:           collateral,
                    tokenOut:          usdc,
                    fee:               swapFee,
                    recipient:         address(this),
                    amountIn:          collBal,
                    amountOutMinimum:  0,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (collateral == usdc) {
            usdcReceived = collBal;
        }

        // Dynamic fee extraction based on position health factor
        uint256 feeBps   = getDynamicFee(healthFactor);
        uint256 gross    = IERC20(usdc).balanceOf(address(this));
        uint256 feeAmt   = gross * feeBps / BPS;
        uint256 profit   = gross > feeAmt ? gross - feeAmt : 0;

        // Track metrics
        totalFeesCollected += feeAmt;
        totalLiquidations  += 1;

        // Pay Flashbots builder from ETH if available (Ethereum mainnet)
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            uint256 tip = ethBal * 80 / 100;
            (bool ok,) = block.coinbase.call{value: tip}("");
        }

        // Send profit to owner
        if (profit > 0) {
            IERC20(usdc).transfer(owner, profit);
        }

        return true;
    }

    // COMPOUND V3 LIQUIDATION
    function compoundLiquidate(
        address comet,
        address borrower,
        address collateralAsset,
        uint24  swapFee
    ) external nonReentrant onlyOwner {
        // Absorb the underwater account
        address[] memory accounts = new address[](1);
        accounts[0] = borrower;
        ICompound(comet).absorb(address(this), accounts);

        // Swap seized collateral to USDC
        uint256 collBal = IERC20(collateralAsset).balanceOf(address(this));
        if (collBal > 0 && collateralAsset != usdc) {
            IERC20(collateralAsset).approve(router, collBal);
            ISwapRouter(router).exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn:           collateralAsset,
                    tokenOut:          usdc,
                    fee:               swapFee,
                    recipient:         owner,
                    amountIn:          collBal,
                    amountOutMinimum:  0,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (collBal > 0) {
            IERC20(usdc).transfer(owner, collBal);
        }

        totalLiquidations += 1;
    }

    // DEX ARBITRAGE — backrun / CEX-DEX
    function backrun(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  buyFee,
        uint24  sellFee,
        uint256 minProfit
    ) external nonReentrant onlyOwner {
        IERC20(tokenIn).approve(router, amountIn);

        // Buy on lower-priced pool
        uint256 received = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               buyFee,
                recipient:         address(this),
                amountIn:          amountIn,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );

        // Sell on higher-priced pool
        IERC20(tokenOut).approve(router, received);
        uint256 finalOut = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenOut,
                tokenOut:          tokenIn,
                fee:               sellFee,
                recipient:         address(this),
                amountIn:          received,
                amountOutMinimum:  amountIn + minProfit,
                sqrtPriceLimitX96: 0
            })
        );

        // Send profit to owner
        uint256 profit = finalOut > amountIn ? finalOut - amountIn : 0;
        if (profit > 0) {
            IERC20(tokenIn).transfer(owner, profit);
        }
    }

    // DEX ARBITRAGE — dexArb (called by cexdex.js)
    function dexArb(
        address tokenA,
        address tokenB,
        uint256 amountIn,
        uint24  feeLow,
        uint24  feeHigh
    ) external nonReentrant onlyOwner {
        // Same as backrun with different naming for CEX-DEX path
        IERC20(tokenA).approve(router, amountIn);

        uint256 received = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenA,
                tokenOut:          tokenB,
                fee:               feeLow,
                recipient:         address(this),
                amountIn:          amountIn,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenB).approve(router, received);
        uint256 finalOut = ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenB,
                tokenOut:          tokenA,
                fee:               feeHigh,
                recipient:         owner,
                amountIn:          received,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    // JIT liquidity provision hooks
    function jitProvide(
        address pool,
        int24   tickLower,
        int24   tickUpper,
        uint256 amount0,
        uint256 amount1
    ) external nonReentrant onlyOwner {
        // Position manager interaction happens externally
        // This function receives and holds tokens during JIT
        emit JITProvided(pool, tickLower, tickUpper, amount0, amount1);
    }

    function jitWithdraw(uint256 tokenId) external nonReentrant onlyOwner {
        // Signal withdrawal — position manager called externally
        emit JITWithdrawn(tokenId);
    }

    // Emergency rescue
    function rescue(address token) external onlyOwner {
        uint256 b = IERC20(token).balanceOf(address(this));
        if (b > 0) IERC20(token).transfer(owner, b);
    }

    // View functions
    function getFeeForHF(uint256 healthFactor) external pure returns (uint256 feeBps, string memory tier) {
        uint256 fee = getDynamicFee(healthFactor);
        if (fee == FEE_TIER_4) return (fee, "CATASTROPHIC 50%");
        if (fee == FEE_TIER_3) return (fee, "SEVERE 30%");
        if (fee == FEE_TIER_2) return (fee, "DEEP 15%");
        if (fee == FEE_TIER_1) return (fee, "CLEAR 5%");
        return (fee, "MARGINAL 1%");
    }

    event JITProvided(address pool, int24 tickLower, int24 tickUpper, uint256 amount0, uint256 amount1);
    event JITWithdrawn(uint256 tokenId);

    receive() external payable {}
}
