// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Vm } from "../../test/utils/Vm.sol";

abstract contract ScriptBase {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

