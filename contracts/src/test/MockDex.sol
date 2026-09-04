// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only: a constant-rate "DEX" that pays `amountIn * rateBps / 10000` in the output token.
contract MockDex {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 rateBps, address to) external returns (uint256 out) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        out = (amountIn * rateBps) / 10_000;
        IERC20(tokenOut).transfer(to, out);
    }
}

contract TestToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
