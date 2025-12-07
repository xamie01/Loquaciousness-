// contracts/interfaces/V3FactoryWrapper.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// This correctly imports the interface from the installed package
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";

// We create a wrapper interface here.
interface IUniswapV3FactoryWrapper is IUniswapV3Factory {}
