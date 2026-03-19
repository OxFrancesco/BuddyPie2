import { keccak256, maxUint256, parseAbi, stringToHex } from 'viem'

export const USDC_ATOMIC_UNITS_PER_USD_CENT = 10_000n

export const delegatedBudgetContractAbi = parseAbi([
  'function createBudget(bytes32 budgetId, address delegatorSmartAccount, address delegate, uint8 budgetType, uint8 interval, uint256 configuredAmount)',
  'function revokeBudget(bytes32 budgetId)',
  'function settleBudget(bytes32 budgetId, bytes32 settlementId, uint256 amount) returns (uint256 remainingAmount)',
  'function getBudget(bytes32 budgetId) view returns ((address owner, address delegate, address delegatorSmartAccount, address token, uint256 configuredAmount, uint256 remainingAmount, uint64 periodStartAt, uint64 periodEndsAt, uint64 lastSettlementAt, uint64 lastRevokedAt, uint8 budgetType, uint8 interval, bool active, bool revoked))',
  'function isSettlementUsed(bytes32 budgetId, bytes32 settlementId) view returns (bool)',
])

export const erc20ApprovalAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

export const erc20TransferAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

export type DelegatedBudgetType = 'fixed' | 'periodic'
export type DelegatedBudgetInterval = 'day' | 'week' | 'month'

export function delegatedBudgetTypeToContractEnum(type: DelegatedBudgetType) {
  return type === 'periodic' ? 1 : 0
}

export function delegatedBudgetIntervalToContractEnum(
  interval?: DelegatedBudgetInterval | null,
) {
  switch (interval) {
    case 'day':
      return 1
    case 'week':
      return 2
    case 'month':
      return 3
    default:
      return 0
  }
}

export function usdCentsToUsdcAtomic(amountUsdCents: number) {
  return BigInt(amountUsdCents) * USDC_ATOMIC_UNITS_PER_USD_CENT
}

export function delegatedBudgetIntervalToDurationSeconds(
  interval: DelegatedBudgetInterval,
) {
  switch (interval) {
    case 'day':
      return 24 * 60 * 60
    case 'week':
      return 7 * 24 * 60 * 60
    case 'month':
      return 30 * 24 * 60 * 60
  }
}

export function getDelegatedBudgetApprovalAmount(args: {
  amountUsdCents: number
  budgetType: DelegatedBudgetType
}) {
  if (args.budgetType === 'periodic') {
    return maxUint256
  }

  return usdCentsToUsdcAtomic(args.amountUsdCents)
}

export function buildDelegatedBudgetId(seed: string) {
  return keccak256(stringToHex(seed))
}

export function advanceDelegatedBudgetPeriodEndMs(
  periodStartAt: number,
  interval: DelegatedBudgetInterval,
) {
  return (
    periodStartAt + delegatedBudgetIntervalToDurationSeconds(interval) * 1000
  )
}
