# BuddyPie Delegated Budget Settlement Audit Notes

This is a contract-side review artifact for the current `BuddyPieDelegatedBudgetSettlement` implementation.
It is not a substitute for an external security audit before Base mainnet deployment.

## Verified Properties

- Smart-account authority only:
  - `createBudget` reverts unless `msg.sender == delegatorSmartAccount`
  - `settleBudget` reverts unless `msg.sender == delegatorSmartAccount`
  - direct backend EOA settlement is rejected onchain
- Replay protection:
  - each `settlementId` is single-use per `budgetId`
- Revocation:
  - revoked budgets cannot be settled again
- Treasury enforcement:
  - payout destination is the immutable contract treasury
- Token enforcement:
  - budget settlements always use the immutable constructor token
- Fixed budget enforcement:
  - remaining amount decreases monotonically until exhausted
- Periodic budget enforcement:
  - remaining amount resets to `configuredAmount` only when the configured period rolls over
  - `month` is implemented as a fixed 30-day rolling interval to match the toolkit's second-based periodic spend scopes

## Assumptions

- The smart account has approved this contract to move the configured token.
- Off-chain delegation policy is configured so only the intended backend delegate can trigger smart-account execution.
- The settlement token is a standard ERC-20 whose `transferFrom` returns `true` on success.

## Remaining Risks / External Audit Scope

- The contract trusts the configured ERC-20 token implementation.
- Budget periods depend on `block.timestamp`, which is acceptable for coarse day/week/month allowances but should be acknowledged in threat modeling.
- Off-chain settlement orchestration and delegation redemption are out of scope for this contract-only review.
- Mainnet launch should still receive an external audit focused on:
  - delegated execution assumptions
  - approval lifecycle and allowance exhaustion behavior
  - operational controls around treasury rotation and deployment configuration
