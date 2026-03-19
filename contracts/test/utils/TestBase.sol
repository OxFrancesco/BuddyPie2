// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Vm } from "./Vm.sol";

abstract contract TestBase {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  function assertEq(uint256 left, uint256 right, string memory message) internal pure {
    if (left != right) {
      revert(message);
    }
  }

  function assertEq(address left, address right, string memory message) internal pure {
    if (left != right) {
      revert(message);
    }
  }

  function assertEq(bool left, bool right, string memory message) internal pure {
    if (left != right) {
      revert(message);
    }
  }

  function assertTrue(bool value, string memory message) internal pure {
    if (!value) {
      revert(message);
    }
  }
}

