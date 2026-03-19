// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface Vm {
  function prank(address msgSender) external;
  function warp(uint256 newTimestamp) external;
  function expectRevert(bytes4 revertData) external;
  function envAddress(string calldata name) external returns (address);
  function envUint(string calldata name) external returns (uint256);
  function startBroadcast(uint256 privateKey) external;
  function stopBroadcast() external;
}

