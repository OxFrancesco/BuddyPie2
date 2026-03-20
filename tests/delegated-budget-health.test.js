import { describe, expect, test } from 'bun:test'
import { classifyDelegatedBudgetHealth } from '../src/lib/server/delegated-budget.ts'

describe('classifyDelegatedBudgetHealth', () => {
  test('marks undeployed smart accounts as needing recreation', () => {
    expect(
      classifyDelegatedBudgetHealth({
        budgetStatus: 'active',
        delegateMatchesEnvironment: true,
        treasuryMatchesEnvironment: true,
        hasTreasuryAddress: true,
        delegationHashMatches: true,
        delegatorSmartAccountDeployed: false,
      }),
    ).toEqual({
      health: 'needs_recreate',
      healthReason: 'undeployed_smart_account',
    })
  })

  test('marks mismatched delegates as needing recreation', () => {
    expect(
      classifyDelegatedBudgetHealth({
        budgetStatus: 'active',
        delegateMatchesEnvironment: false,
        treasuryMatchesEnvironment: true,
        hasTreasuryAddress: true,
        delegationHashMatches: true,
        delegatorSmartAccountDeployed: true,
      }),
    ).toEqual({
      health: 'needs_recreate',
      healthReason: 'delegate_mismatch',
    })
  })

  test('keeps deployed active budgets usable', () => {
    expect(
      classifyDelegatedBudgetHealth({
        budgetStatus: 'active',
        delegateMatchesEnvironment: true,
        treasuryMatchesEnvironment: true,
        hasTreasuryAddress: true,
        delegationHashMatches: true,
        delegatorSmartAccountDeployed: true,
        onchainStatus: 'active',
      }),
    ).toEqual({
      health: 'usable',
      healthReason: 'unknown',
    })
  })
})
