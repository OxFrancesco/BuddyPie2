// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockERC20 {
  string public name = "Mock USDC";
  string public symbol = "mUSDC";
  uint8 public decimals = 6;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 amount);
  event Approval(address indexed owner, address indexed spender, uint256 amount);

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowedAmount = allowance[from][msg.sender];
    if (allowedAmount < amount) {
      revert("allowance");
    }

    uint256 currentBalance = balanceOf[from];
    if (currentBalance < amount) {
      revert("balance");
    }

    unchecked {
      allowance[from][msg.sender] = allowedAmount - amount;
      balanceOf[from] = currentBalance - amount;
      balanceOf[to] += amount;
    }

    emit Transfer(from, to, amount);
    return true;
  }
}

