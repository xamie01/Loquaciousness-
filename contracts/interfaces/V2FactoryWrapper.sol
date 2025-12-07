// contracts/interfaces/V2FactoryWrapper.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// This correctly imports the interface from the installed package
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";

// We create a wrapper interface here.
interface IUniswapV2FactoryWrapper is IUniswapV2Factory {}
