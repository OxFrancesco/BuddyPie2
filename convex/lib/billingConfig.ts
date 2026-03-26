export const BILLING_CURRENCY = 'USD' as const
export const BILLING_PRICE_VERSION = 'buddy_wallet_2026_03_18_v1'

export const billingEnvironmentValues = ['staging', 'production'] as const
export type BillingEnvironment = (typeof billingEnvironmentValues)[number]

export const billingEventTypeValues = [
  'sandbox_launch',
  'preview_boot',
  'ssh_access',
  'web_terminal',
] as const
export type BillingEventType = (typeof billingEventTypeValues)[number]

export const creditHoldPurposeValues = [
  'sandbox_launch',
  'preview_boot',
  'ssh_access',
  'web_terminal',
  'generic',
] as const
export type CreditHoldPurpose = (typeof creditHoldPurposeValues)[number]

export const billingPaymentMethodValues = [
  'credits',
  'x402',
  'delegated_budget',
] as const
export type BillingPaymentMethod = (typeof billingPaymentMethodValues)[number]

export const billingPaymentRailValues = [
  'clerk_credit',
  'x402_direct',
  'metamask_delegated',
  'migration',
  'manual_test',
] as const
export type BillingPaymentRail = (typeof billingPaymentRailValues)[number]

export const delegatedBudgetStatusValues = [
  'active',
  'revoked',
  'expired',
  'pending',
] as const
export type DelegatedBudgetStatus = (typeof delegatedBudgetStatusValues)[number]

export const delegatedBudgetTypeValues = ['fixed', 'periodic'] as const
export type DelegatedBudgetType = (typeof delegatedBudgetTypeValues)[number]

export const delegatedBudgetIntervalValues = ['day', 'week', 'month'] as const
export type DelegatedBudgetInterval = (typeof delegatedBudgetIntervalValues)[number]

export const creditHoldStatusValues = [
  'active',
  'captured',
  'released',
  'expired',
] as const
export type CreditHoldStatus = (typeof creditHoldStatusValues)[number]

export const ledgerReferenceTypeValues = [
  'migration_opening',
  'subscription_grant',
  'manual_grant',
  'hold_created',
  'hold_released',
  'hold_captured',
  'x402_charge',
  'delegated_budget_charge',
] as const
export type LedgerReferenceType = (typeof ledgerReferenceTypeValues)[number]

export const clerkSubscriptionStatusValues = [
  'active',
  'past_due',
  'canceled',
  'ended',
  'abandoned',
  'incomplete',
  'upcoming',
] as const
export type ClerkSubscriptionStatus = (typeof clerkSubscriptionStatusValues)[number]

const launchCostByPreset: Record<string, number> = {
  'general-engineer': 250,
  'frontend-builder': 250,
  'docs-writer': 250,
  'nansen-analyst': 250,
}

const fixedEventCostsUsdCents: Record<
  Exclude<BillingEventType, 'sandbox_launch'>,
  number
> = {
  preview_boot: 35,
  ssh_access: 15,
  web_terminal: 15,
}

type ClerkPlanCreditGrantConfig = {
  month: number
  annual: number
}

const defaultClerkPlanCreditGrants: Record<string, ClerkPlanCreditGrantConfig> = {
  starter: {
    month: 2_000,
    annual: 24_000,
  },
  pro: {
    month: 7_500,
    annual: 90_000,
  },
  team: {
    month: 15_000,
    annual: 180_000,
  },
}

const MAX_CONVEX_ENV_NAME_LENGTH = 39

const billingScopedEnvAliases: Partial<
  Record<string, Partial<Record<BillingEnvironment, string>>>
> = {
  DELEGATED_BUDGET_SETTLEMENT_CONTRACT_ADDRESS: {
    staging: 'DB_SETTLEMENT_ADDR_STG',
    production: 'DB_SETTLEMENT_ADDR_PROD',
  },
  DELEGATED_BUDGET_TREASURY_ADDRESS: {
    staging: 'DB_TREASURY_ADDR_STG',
    production: 'DB_TREASURY_ADDR_PROD',
  },
  DELEGATED_BUDGET_BACKEND_DELEGATE_ADDRESS: {
    staging: 'DB_BACKEND_DELEGATE_STG',
    production: 'DB_BACKEND_DELEGATE_PROD',
  },
  DELEGATED_BUDGET_RPC_URL: {
    staging: 'DB_RPC_URL_STG',
    production: 'DB_RPC_URL_PROD',
  },
  DELEGATED_BUDGET_BUNDLER_URL: {
    staging: 'DB_BUNDLER_URL_STG',
    production: 'DB_BUNDLER_URL_PROD',
  },
  DELEGATED_BUDGET_BACKEND_PRIVATE_KEY: {
    staging: 'DB_BACKEND_PK_STG',
  },
}

function parsePositiveWholeNumber(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null
  }

  return value
}

function parsePlanCreditGrantConfig(rawValue: string | undefined) {
  if (!rawValue) {
    return defaultClerkPlanCreditGrants
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<
      string,
      { month?: unknown; annual?: unknown }
    >
    const normalized: Record<string, ClerkPlanCreditGrantConfig> = {}

    for (const [planSlug, candidate] of Object.entries(parsed)) {
      const normalizedSlug = planSlug.trim()

      if (!normalizedSlug) {
        continue
      }

      const month = parsePositiveWholeNumber(candidate.month)
      const annual = parsePositiveWholeNumber(candidate.annual)

      if (month === null || annual === null) {
        continue
      }

      normalized[normalizedSlug] = {
        month,
        annual,
      }
    }

    return Object.keys(normalized).length > 0
      ? normalized
      : defaultClerkPlanCreditGrants
  } catch {
    return defaultClerkPlanCreditGrants
  }
}

function readEnvironmentValue(name: string | undefined) {
  if (!name || name.length > MAX_CONVEX_ENV_NAME_LENGTH) {
    return ''
  }

  return process.env[name]?.trim() || ''
}

export function resolveBillingEnvironment(): BillingEnvironment {
  const candidate = process.env.BILLING_ENVIRONMENT?.trim().toLowerCase()

  if (candidate === 'production') {
    return 'production'
  }

  return 'staging'
}

export function readBillingEnvironmentScopedValue(baseName: string) {
  const environment = resolveBillingEnvironment()
  const scopedName =
    environment === 'production'
      ? `${baseName}_PRODUCTION`
      : `${baseName}_STAGING`
  const aliasName = billingScopedEnvAliases[baseName]?.[environment]

  return (
    readEnvironmentValue(aliasName) ||
    readEnvironmentValue(scopedName) ||
    readEnvironmentValue(baseName)
  )
}

export function getBillingEnvironmentConfig() {
  const environment = resolveBillingEnvironment()

  if (environment === 'production') {
    return {
      environment,
      chainId: 8453,
      fundingNetwork: 'base-mainnet',
      x402Network: 'eip155:8453',
      fundingAsset:
        process.env.X402_USDC_ASSET?.trim() ||
        '0x833589fCD6EDB6E08f4c7C32D4f71b54bdA02913',
      fundingAssetSymbol: 'USDC',
    } as const
  }

  return {
    environment,
    chainId: 84532,
    fundingNetwork: 'base-sepolia',
    x402Network: 'eip155:84532',
    fundingAsset:
      process.env.X402_USDC_ASSET?.trim() ||
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    fundingAssetSymbol: 'USDC',
  } as const
}

export function getDelegatedBudgetEnvironmentConfig() {
  const billing = getBillingEnvironmentConfig()
  const settlementContract = readBillingEnvironmentScopedValue(
    'DELEGATED_BUDGET_SETTLEMENT_CONTRACT_ADDRESS',
  )
  const treasuryAddress = readBillingEnvironmentScopedValue(
    'DELEGATED_BUDGET_TREASURY_ADDRESS',
  )
  const backendDelegateAddress = readBillingEnvironmentScopedValue(
    'DELEGATED_BUDGET_BACKEND_DELEGATE_ADDRESS',
  )
  const bundlerUrl = readBillingEnvironmentScopedValue(
    'DELEGATED_BUDGET_BUNDLER_URL',
  )

  return {
    enabled:
      settlementContract.length > 0 &&
      treasuryAddress.length > 0 &&
      backendDelegateAddress.length > 0 &&
      bundlerUrl.length > 0,
    chainId: billing.chainId,
    network: billing.fundingNetwork,
    tokenAddress: billing.fundingAsset,
    tokenSymbol: billing.fundingAssetSymbol,
    settlementContract,
    treasuryAddress,
    backendDelegateAddress,
    bundlerUrl,
  } as const
}

export function formatUsdCents(amountUsdCents: number) {
  return `$${(amountUsdCents / 100).toFixed(2)}`
}

export function getBillingEventPriceUsdCents(
  agentPresetId: string,
  eventType: BillingEventType,
) {
  if (eventType === 'sandbox_launch') {
    return launchCostByPreset[agentPresetId] ?? launchCostByPreset['general-engineer']
  }

  return fixedEventCostsUsdCents[eventType]
}

export function getClerkPlanCreditGrantUsdCents(args: {
  planSlug?: string | null
  planPeriod?: 'month' | 'annual' | null
}) {
  const planSlug = args.planSlug?.trim().toLowerCase()
  const planPeriod = args.planPeriod ?? 'month'

  if (!planSlug) {
    return 0
  }

  const config = parsePlanCreditGrantConfig(
    process.env.CLERK_BILLING_PLAN_CREDIT_GRANTS_JSON,
  )[planSlug]

  if (!config) {
    return 0
  }

  return planPeriod === 'annual' ? config.annual : config.month
}
