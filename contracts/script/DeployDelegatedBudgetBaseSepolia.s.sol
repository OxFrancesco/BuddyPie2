// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { BuddyPieDelegatedBudgetSettlement } from "../src/BuddyPieDelegatedBudgetSettlement.sol";
import { ScriptBase } from "./utils/ScriptBase.sol";

contract DeployDelegatedBudgetBaseSepolia is ScriptBase {
  function run() external returns (BuddyPieDelegatedBudgetSettlement deployment) {
    uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
    address treasury = vm.envAddress("BUDDYPIE_TREASURY");
    address usdcToken = vm.envAddress("BUDDYPIE_USDC");

    vm.startBroadcast(deployerPrivateKey);
    deployment = new BuddyPieDelegatedBudgetSettlement(treasury, usdcToken);
    vm.stopBroadcast();
  }
}

