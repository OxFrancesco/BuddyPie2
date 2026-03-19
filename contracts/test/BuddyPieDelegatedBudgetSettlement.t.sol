// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { BuddyPieDelegatedBudgetSettlement } from "../src/BuddyPieDelegatedBudgetSettlement.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { TestBase } from "./utils/TestBase.sol";

contract BuddyPieDelegatedBudgetSettlementTest is TestBase {
  uint256 internal constant INITIAL_BALANCE = 1_000_000_000;
  uint256 internal constant FIXED_BUDGET_AMOUNT = 250_000_000;
  uint256 internal constant PERIODIC_BUDGET_AMOUNT = 100_000_000;

  address internal constant SMART_ACCOUNT = address(0xA11CE);
  address internal constant BACKEND_DELEGATE = address(0xB0B);
  address internal constant TREASURY = address(0xC0FFEE);
  address internal constant ATTACKER = address(0xD00D);

  bytes32 internal constant FIXED_BUDGET_ID = keccak256("fixed-budget");
  bytes32 internal constant PERIODIC_BUDGET_ID = keccak256("periodic-budget");
  bytes32 internal constant SETTLEMENT_ID_ONE = keccak256("settlement-one");
  bytes32 internal constant SETTLEMENT_ID_TWO = keccak256("settlement-two");

  MockERC20 internal token;
  BuddyPieDelegatedBudgetSettlement internal settlement;

  function setUp() public {
    token = new MockERC20();
    settlement = new BuddyPieDelegatedBudgetSettlement(TREASURY, address(token));

    token.mint(SMART_ACCOUNT, INITIAL_BALANCE);
  }

  function testCreateBudgetRequiresSmartAccountCaller() public {
    vm.expectRevert(BuddyPieDelegatedBudgetSettlement.CallerMustBeDelegatorSmartAccount.selector);
    settlement.createBudget(
      FIXED_BUDGET_ID,
      SMART_ACCOUNT,
      BACKEND_DELEGATE,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Fixed,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.None,
      FIXED_BUDGET_AMOUNT
    );
  }

  function testFixedBudgetSettlesOnlyThroughSmartAccountAuthority() public {
    _createBudget(
      FIXED_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Fixed,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.None,
      FIXED_BUDGET_AMOUNT
    );

    vm.prank(SMART_ACCOUNT);
    uint256 remainingAmount =
      settlement.settleBudget(FIXED_BUDGET_ID, SETTLEMENT_ID_ONE, 50_000_000);

    BuddyPieDelegatedBudgetSettlement.Budget memory budget = settlement.getBudget(FIXED_BUDGET_ID);
    assertEq(remainingAmount, 200_000_000, "fixed remaining amount should decrease");
    assertEq(budget.owner, SMART_ACCOUNT, "smart account should own the budget");
    assertEq(budget.delegatorSmartAccount, SMART_ACCOUNT, "smart account should stay authority");
    assertEq(token.balanceOf(TREASURY), 50_000_000, "treasury should receive the settlement");
    assertEq(
      token.balanceOf(SMART_ACCOUNT),
      INITIAL_BALANCE - 50_000_000,
      "smart account should pay the settlement"
    );
  }

  function testPeriodicBudgetResetsAfterPeriodBoundary() public {
    _createBudget(
      PERIODIC_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Periodic,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.Day,
      PERIODIC_BUDGET_AMOUNT
    );

    vm.prank(SMART_ACCOUNT);
    settlement.settleBudget(PERIODIC_BUDGET_ID, SETTLEMENT_ID_ONE, 60_000_000);

    vm.warp(block.timestamp + 1 days + 1);

    vm.prank(SMART_ACCOUNT);
    uint256 remainingAmount =
      settlement.settleBudget(PERIODIC_BUDGET_ID, SETTLEMENT_ID_TWO, 25_000_000);

    BuddyPieDelegatedBudgetSettlement.Budget memory budget =
      settlement.getBudget(PERIODIC_BUDGET_ID);
    assertEq(remainingAmount, 75_000_000, "periodic budget should reset before settlement");
    assertEq(budget.remainingAmount, 75_000_000, "stored periodic remaining amount should match");
    assertTrue(budget.periodEndsAt > budget.periodStartAt, "periodic window should remain open");
  }

  function testMonthlyBudgetResetsAfterThirtyDays() public {
    _createBudget(
      PERIODIC_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Periodic,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.Month,
      PERIODIC_BUDGET_AMOUNT
    );

    vm.prank(SMART_ACCOUNT);
    settlement.settleBudget(PERIODIC_BUDGET_ID, SETTLEMENT_ID_ONE, 40_000_000);

    vm.warp(block.timestamp + 30 days + 1);

    vm.prank(SMART_ACCOUNT);
    uint256 remainingAmount =
      settlement.settleBudget(PERIODIC_BUDGET_ID, SETTLEMENT_ID_TWO, 15_000_000);

    BuddyPieDelegatedBudgetSettlement.Budget memory budget =
      settlement.getBudget(PERIODIC_BUDGET_ID);
    assertEq(remainingAmount, 85_000_000, "monthly budget should reset after thirty days");
    assertEq(budget.remainingAmount, 85_000_000, "monthly remaining amount should persist");
  }

  function testRevokedBudgetBlocksSettlement() public {
    _createBudget(
      FIXED_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Fixed,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.None,
      FIXED_BUDGET_AMOUNT
    );

    vm.prank(SMART_ACCOUNT);
    settlement.revokeBudget(FIXED_BUDGET_ID);

    vm.prank(SMART_ACCOUNT);
    vm.expectRevert(BuddyPieDelegatedBudgetSettlement.BudgetIsRevoked.selector);
    settlement.settleBudget(FIXED_BUDGET_ID, SETTLEMENT_ID_ONE, 10_000_000);
  }

  function testSettlementReplayIsRejected() public {
    _createBudget(
      FIXED_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Fixed,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.None,
      FIXED_BUDGET_AMOUNT
    );

    vm.prank(SMART_ACCOUNT);
    settlement.settleBudget(FIXED_BUDGET_ID, SETTLEMENT_ID_ONE, 10_000_000);

    vm.prank(SMART_ACCOUNT);
    vm.expectRevert(BuddyPieDelegatedBudgetSettlement.SettlementAlreadyUsed.selector);
    settlement.settleBudget(FIXED_BUDGET_ID, SETTLEMENT_ID_ONE, 10_000_000);
  }

  function testDirectBackendDelegateSettlementIsRejected() public {
    _createBudget(
      FIXED_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Fixed,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.None,
      FIXED_BUDGET_AMOUNT
    );

    vm.prank(BACKEND_DELEGATE);
    vm.expectRevert(BuddyPieDelegatedBudgetSettlement.NotAuthorizedSettler.selector);
    settlement.settleBudget(FIXED_BUDGET_ID, SETTLEMENT_ID_ONE, 10_000_000);
  }

  function testUnauthorizedCallerCannotSettle() public {
    _createBudget(
      FIXED_BUDGET_ID,
      BuddyPieDelegatedBudgetSettlement.BudgetType.Fixed,
      BuddyPieDelegatedBudgetSettlement.PeriodInterval.None,
      FIXED_BUDGET_AMOUNT
    );

    vm.prank(ATTACKER);
    vm.expectRevert(BuddyPieDelegatedBudgetSettlement.NotAuthorizedSettler.selector);
    settlement.settleBudget(FIXED_BUDGET_ID, SETTLEMENT_ID_ONE, 10_000_000);
  }

  function _createBudget(
    bytes32 budgetId,
    BuddyPieDelegatedBudgetSettlement.BudgetType budgetType,
    BuddyPieDelegatedBudgetSettlement.PeriodInterval interval,
    uint256 configuredAmount
  ) internal {
    vm.prank(SMART_ACCOUNT);
    token.approve(address(settlement), configuredAmount);

    vm.prank(SMART_ACCOUNT);
    settlement.createBudget(
      budgetId, SMART_ACCOUNT, BACKEND_DELEGATE, budgetType, interval, configuredAmount
    );
  }
}
