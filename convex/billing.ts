import { ConvexError, v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { internalMutation, mutation, query } from './_generated/server'
import { getCurrentUserRecord, requireCurrentUserRecord } from './lib/auth'
import {
  BILLING_CURRENCY,
  BILLING_PRICE_VERSION,
  getDelegatedBudgetEnvironmentConfig,
  getBillingEnvironmentConfig,
  getBillingEventPriceUsdCents,
} from './lib/billingConfig'
import {
  applySubscriptionCreditGrant as applySubscriptionCreditGrantToWallet,
  captureCreditHold as captureCreditHoldInWallet,
  createDelegatedBudget as createDelegatedBudgetInStore,
  expireActiveCreditHolds,
  getCreditAccount,
  getCurrentPlanSnapshot,
  getDelegatedBudgetSummary,
  getSandboxCharges,
  getUsageEventCostUsdCents,
  getWalletSnapshot,
  holdCredits as holdCreditsInWallet,
  recordDelegatedBudgetCharge as recordDelegatedBudgetChargeInStore,
  recordX402Charge,
  refreshDelegatedBudget as refreshDelegatedBudgetInStore,
  releaseCreditHold as releaseCreditHoldInWallet,
  revokeDelegatedBudget as revokeDelegatedBudgetInStore,
} from './lib/billing'

const billingEventTypeValidator = v.union(
  v.literal('sandbox_launch'),
  v.literal('preview_boot'),
  v.literal('ssh_access'),
  v.literal('web_terminal'),
)

const creditHoldValidator = v.object({
  _id: v.id('creditHolds'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.id('creditAccounts'),
  sandboxId: v.optional(v.id('sandboxes')),
  agentPresetId: v.string(),
  purpose: v.union(
    v.literal('sandbox_launch'),
    v.literal('preview_boot'),
    v.literal('ssh_access'),
    v.literal('web_terminal'),
    v.literal('generic'),
  ),
  amountUsdCents: v.number(),
  sourcePaymentRail: v.union(
    v.literal('clerk_credit'),
    v.literal('migration'),
    v.literal('manual_test'),
  ),
  status: v.union(
    v.literal('active'),
    v.literal('captured'),
    v.literal('released'),
    v.literal('expired'),
  ),
  expiresAt: v.number(),
  idempotencyKey: v.string(),
  migrationReference: v.optional(v.string()),
  quantitySummary: v.optional(v.string()),
  description: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  capturedAt: v.optional(v.number()),
  releasedAt: v.optional(v.number()),
})

const billingChargeValidator = v.object({
  _id: v.id('billingCharges'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.optional(v.id('creditAccounts')),
  sandboxId: v.optional(v.id('sandboxes')),
  holdId: v.optional(v.id('creditHolds')),
  agentPresetId: v.string(),
  eventType: billingEventTypeValidator,
  paymentRail: v.union(
    v.literal('clerk_credit'),
    v.literal('x402_direct'),
    v.literal('metamask_delegated'),
    v.literal('migration'),
    v.literal('manual_test'),
  ),
  amountUsdCents: v.number(),
  unitPriceVersion: v.string(),
  quantitySummary: v.optional(v.string()),
  description: v.string(),
  idempotencyKey: v.string(),
  externalReference: v.optional(v.string()),
  metadataJson: v.optional(v.string()),
  createdAt: v.number(),
})

const creditLedgerEntryValidator = v.object({
  _id: v.id('creditLedgerEntries'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.id('creditAccounts'),
  sandboxId: v.optional(v.id('sandboxes')),
  holdId: v.optional(v.id('creditHolds')),
  chargeId: v.optional(v.id('billingCharges')),
  paymentRail: v.union(
    v.literal('clerk_credit'),
    v.literal('x402_direct'),
    v.literal('metamask_delegated'),
    v.literal('migration'),
    v.literal('manual_test'),
  ),
  referenceType: v.union(
    v.literal('migration_opening'),
    v.literal('subscription_grant'),
    v.literal('manual_grant'),
    v.literal('hold_created'),
    v.literal('hold_released'),
    v.literal('hold_captured'),
    v.literal('x402_charge'),
    v.literal('delegated_budget_charge'),
  ),
  amountUsdCents: v.number(),
  balanceDeltaAvailableUsdCents: v.number(),
  balanceDeltaHeldUsdCents: v.number(),
  description: v.string(),
  createdAt: v.number(),
})

const currentPlanValidator = v.object({
  _id: v.id('clerkSubscriptionSnapshots'),
  _creationTime: v.number(),
  userId: v.id('users'),
  clerkUserId: v.string(),
  clerkSubscriptionId: v.string(),
  clerkSubscriptionItemId: v.optional(v.string()),
  status: v.union(
    v.literal('active'),
    v.literal('past_due'),
    v.literal('canceled'),
    v.literal('ended'),
    v.literal('abandoned'),
    v.literal('incomplete'),
    v.literal('upcoming'),
  ),
  planSlug: v.optional(v.string()),
  planName: v.optional(v.string()),
  planPeriod: v.optional(v.union(v.literal('month'), v.literal('annual'))),
  payerType: v.literal('user'),
  periodStart: v.optional(v.number()),
  periodEnd: v.optional(v.number()),
  rawJson: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})

const walletValidator = v.object({
  accountId: v.optional(v.id('creditAccounts')),
  currency: v.literal('USD'),
  availableUsdCents: v.number(),
  heldUsdCents: v.number(),
  lifetimeCreditedUsdCents: v.number(),
  lifetimeSpentUsdCents: v.number(),
  fundingAsset: v.literal('USDC'),
  fundingNetwork: v.union(
    v.literal('base-sepolia'),
    v.literal('base-mainnet'),
  ),
  environment: v.union(v.literal('staging'), v.literal('production')),
  chainId: v.number(),
  x402Network: v.string(),
})

const delegatedBudgetValidator = v.object({
  status: v.union(
    v.literal('active'),
    v.literal('revoked'),
    v.literal('expired'),
    v.literal('pending'),
  ),
  type: v.union(v.literal('fixed'), v.literal('periodic')),
  interval: v.union(
    v.literal('day'),
    v.literal('week'),
    v.literal('month'),
    v.null(),
  ),
  token: v.literal('USDC'),
  network: v.union(
    v.literal('base-sepolia'),
    v.literal('base-mainnet'),
  ),
  configuredAmountUsdCents: v.number(),
  remainingAmountUsdCents: v.number(),
  periodEndsAt: v.union(v.number(), v.null()),
  delegatorSmartAccount: v.string(),
  delegateAddress: v.string(),
  lastSettlementAt: v.union(v.number(), v.null()),
  lastRevokedAt: v.union(v.number(), v.null()),
})

const delegatedBudgetRecordValidator = v.object({
  _id: v.id('delegatedBudgets'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.optional(v.id('creditAccounts')),
  status: v.union(
    v.literal('active'),
    v.literal('revoked'),
    v.literal('expired'),
    v.literal('pending'),
  ),
  budgetType: v.union(v.literal('fixed'), v.literal('periodic')),
  interval: v.optional(
    v.union(v.literal('day'), v.literal('week'), v.literal('month')),
  ),
  token: v.literal('USDC'),
  network: v.union(
    v.literal('base-sepolia'),
    v.literal('base-mainnet'),
  ),
  configuredAmountUsdCents: v.number(),
  remainingAmountUsdCents: v.number(),
  periodStartedAt: v.optional(v.number()),
  periodEndsAt: v.optional(v.number()),
  ownerAddress: v.string(),
  delegatorSmartAccount: v.string(),
  delegateAddress: v.string(),
  treasuryAddress: v.optional(v.string()),
  settlementContract: v.optional(v.string()),
  contractBudgetId: v.string(),
  delegationJson: v.string(),
  delegationHash: v.string(),
  delegationExpiresAt: v.optional(v.number()),
  approvalMode: v.union(v.literal('exact'), v.literal('standing')),
  approvalTxHash: v.optional(v.string()),
  createTxHash: v.optional(v.string()),
  lastSettlementAt: v.optional(v.number()),
  lastSettlementTxHash: v.optional(v.string()),
  lastRevokedAt: v.optional(v.number()),
  revokeTxHash: v.optional(v.string()),
  revocationMode: v.optional(
    v.union(v.literal('onchain'), v.literal('local_retire')),
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
})

const delegatedBudgetSettlementValidator = v.object({
  _id: v.id('delegatedBudgetSettlements'),
  _creationTime: v.number(),
  userId: v.id('users'),
  delegatedBudgetId: v.id('delegatedBudgets'),
  sandboxId: v.optional(v.id('sandboxes')),
  chargeId: v.optional(v.id('billingCharges')),
  agentPresetId: v.string(),
  eventType: billingEventTypeValidator,
  paymentRail: v.literal('metamask_delegated'),
  amountUsdCents: v.number(),
  contractBudgetId: v.string(),
  settlementId: v.string(),
  txHash: v.string(),
  remainingAmountUsdCents: v.number(),
  periodStartedAt: v.optional(v.number()),
  periodEndsAt: v.optional(v.number()),
  idempotencyKey: v.string(),
  createdAt: v.number(),
})

type BillingChargeRecord = {
  _id: Id<'billingCharges'>
  _creationTime: number
  userId: Id<'users'>
  accountId?: Id<'creditAccounts'>
  sandboxId?: Id<'sandboxes'>
  holdId?: Id<'creditHolds'>
  agentPresetId: string
  eventType: 'sandbox_launch' | 'preview_boot' | 'ssh_access' | 'web_terminal'
  paymentRail:
    | 'clerk_credit'
    | 'x402_direct'
    | 'metamask_delegated'
    | 'migration'
    | 'manual_test'
  amountUsdCents: number
  unitPriceVersion: string
  quantitySummary?: string
  description: string
  idempotencyKey: string
  externalReference?: string
  metadataJson?: string
  createdAt: number
}

function mapLegacyUsageEventToCharge(
  usageEvent: {
    _id: Id<'usageEvents'>
    _creationTime: number
    userId: Id<'users'>
    accountId: Id<'billingAccounts'>
    sandboxId?: Id<'sandboxes'>
    costUsdCents: number
    createdAt: number
    eventType: 'sandbox_launch' | 'preview_boot' | 'ssh_access' | 'web_terminal'
    description: string
    quantitySummary?: string
    idempotencyKey: string
    agentReserveId: string
  },
  sandboxAgentPresetId?: string,
): BillingChargeRecord {
  const mappedCharge: BillingChargeRecord = {
    _id: usageEvent._id as unknown as Id<'billingCharges'>,
    _creationTime: usageEvent._creationTime,
    userId: usageEvent.userId,
    ...(usageEvent.sandboxId ? { sandboxId: usageEvent.sandboxId } : {}),
    agentPresetId: sandboxAgentPresetId ?? 'general-engineer',
    eventType: usageEvent.eventType,
    paymentRail: 'migration',
    amountUsdCents: usageEvent.costUsdCents,
    unitPriceVersion: BILLING_PRICE_VERSION,
    description: usageEvent.description,
    idempotencyKey: usageEvent.idempotencyKey,
    ...(usageEvent.quantitySummary
      ? { quantitySummary: usageEvent.quantitySummary }
      : {}),
    externalReference: usageEvent.agentReserveId,
    createdAt: usageEvent.createdAt,
  }

  return mappedCharge
}

function buildEmptyWalletSnapshot() {
  const environment = getBillingEnvironmentConfig()

  return {
    accountId: undefined,
    currency: BILLING_CURRENCY,
    availableUsdCents: 0,
    heldUsdCents: 0,
    lifetimeCreditedUsdCents: 0,
    lifetimeSpentUsdCents: 0,
    fundingAsset: 'USDC' as const,
    fundingNetwork: environment.fundingNetwork,
    environment: environment.environment,
    chainId: environment.chainId,
    x402Network: environment.x402Network,
  }
}

export const dashboardSummary = query({
  args: {},
  returns: v.object({
    wallet: walletValidator,
    recentCharges: v.array(billingChargeValidator),
    recentLedger: v.array(creditLedgerEntryValidator),
    currentPlan: v.union(currentPlanValidator, v.null()),
    delegatedBudget: v.union(delegatedBudgetValidator, v.null()),
  }),
  handler: async (ctx) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return {
        wallet: buildEmptyWalletSnapshot(),
        recentCharges: [],
        recentLedger: [],
        currentPlan: null,
        delegatedBudget: null,
      }
    }

    const wallet = await getWalletSnapshot(ctx, user._id)
    const account = await getCreditAccount(ctx, user._id)
    const recentCharges = account
      ? await ctx.db
          .query('billingCharges')
          .withIndex('by_user_and_created_at', (q) => q.eq('userId', user._id))
          .order('desc')
          .take(20)
      : []
    const recentLedger = account
      ? await ctx.db
          .query('creditLedgerEntries')
          .withIndex('by_account_and_created_at', (q) => q.eq('accountId', account._id))
          .order('desc')
          .take(20)
      : []
    const currentPlan = await getCurrentPlanSnapshot(ctx, user._id)
    const delegatedBudget = await getDelegatedBudgetSummary(ctx, user._id)

    return {
      wallet,
      recentCharges,
      recentLedger,
      currentPlan,
      delegatedBudget,
    }
  },
})

export const sandboxUsage = query({
  args: {
    sandboxId: v.id('sandboxes'),
  },
  returns: v.object({
    billedUsdCents: v.number(),
    wallet: v.union(walletValidator, v.null()),
    charges: v.array(billingChargeValidator),
    delegatedBudget: v.union(delegatedBudgetValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return {
        billedUsdCents: 0,
        wallet: null,
        charges: [],
        delegatedBudget: null,
      }
    }

    const sandbox = await ctx.db.get(args.sandboxId)

    if (!sandbox || sandbox.userId !== user._id) {
      return {
        billedUsdCents: 0,
        wallet: null,
        charges: [],
        delegatedBudget: null,
      }
    }

    const wallet = await getCreditAccount(ctx, user._id)
      ? await getWalletSnapshot(ctx, user._id)
      : null
    const charges = await getSandboxCharges(ctx, sandbox._id)
    const delegatedBudget = await getDelegatedBudgetSummary(ctx, user._id)

    if (charges.length > 0) {
      return {
        billedUsdCents: sandbox.billedUsdCents ?? 0,
        wallet,
        charges,
        delegatedBudget,
      }
    }

    const legacyUsageEvents = await ctx.db
      .query('usageEvents')
      .withIndex('by_sandbox_and_created_at', (q) => q.eq('sandboxId', args.sandboxId))
      .order('desc')
      .take(20)

    return {
      billedUsdCents: sandbox.billedUsdCents ?? 0,
      wallet,
      charges: legacyUsageEvents.map((event) =>
        mapLegacyUsageEventToCharge(event, sandbox.agentPresetId),
      ),
      delegatedBudget,
    }
  },
})

export const holdCredits = mutation({
  args: {
    sandboxId: v.optional(v.id('sandboxes')),
    agentPresetId: v.string(),
    purpose: v.union(
      v.literal('sandbox_launch'),
      v.literal('preview_boot'),
      v.literal('ssh_access'),
      v.literal('web_terminal'),
      v.literal('generic'),
    ),
    amountUsdCents: v.number(),
    idempotencyKey: v.string(),
    expiresInSeconds: v.optional(v.number()),
    quantitySummary: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  returns: creditHoldValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await holdCreditsInWallet(ctx, {
      userId: user._id,
      sandboxId: args.sandboxId,
      agentPresetId: args.agentPresetId,
      purpose: args.purpose,
      amountUsdCents: args.amountUsdCents,
      idempotencyKey: args.idempotencyKey,
      expiresInSeconds: args.expiresInSeconds,
      quantitySummary: args.quantitySummary,
      description: args.description,
    })
  },
})

export const captureCreditHold = mutation({
  args: {
    holdId: v.id('creditHolds'),
    sandboxId: v.optional(v.id('sandboxes')),
    eventType: billingEventTypeValidator,
    idempotencyKey: v.string(),
    description: v.string(),
    quantitySummary: v.optional(v.string()),
    costUsdCents: v.optional(v.number()),
  },
  returns: billingChargeValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const hold = await ctx.db.get(args.holdId)

    if (!hold || hold.userId !== user._id) {
      throw new ConvexError('Credit hold not found.')
    }

    return await captureCreditHoldInWallet(ctx, args)
  },
})

export const releaseCreditHold = mutation({
  args: {
    holdId: v.id('creditHolds'),
    reason: v.string(),
  },
  returns: creditHoldValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const hold = await ctx.db.get(args.holdId)

    if (!hold || hold.userId !== user._id) {
      throw new ConvexError('Credit hold not found.')
    }

    return await releaseCreditHoldInWallet(ctx, args)
  },
})

export const recordX402DirectCharge = mutation({
  args: {
    sandboxId: v.optional(v.id('sandboxes')),
    agentPresetId: v.string(),
    eventType: billingEventTypeValidator,
    amountUsdCents: v.number(),
    idempotencyKey: v.string(),
    description: v.string(),
    quantitySummary: v.optional(v.string()),
    externalReference: v.string(),
    metadataJson: v.optional(v.string()),
  },
  returns: billingChargeValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await recordX402Charge(ctx, {
      userId: user._id,
      sandboxId: args.sandboxId,
      agentPresetId: args.agentPresetId,
      eventType: args.eventType,
      amountUsdCents: args.amountUsdCents,
      idempotencyKey: args.idempotencyKey,
      description: args.description,
      quantitySummary: args.quantitySummary,
      externalReference: args.externalReference,
      metadataJson: args.metadataJson,
    })
  },
})

export const createDelegatedBudget = mutation({
  args: {
    contractBudgetId: v.string(),
    budgetType: v.union(v.literal('fixed'), v.literal('periodic')),
    interval: v.optional(
      v.union(v.literal('day'), v.literal('week'), v.literal('month')),
    ),
    configuredAmountUsdCents: v.number(),
    remainingAmountUsdCents: v.number(),
    periodStartedAt: v.optional(v.number()),
    periodEndsAt: v.optional(v.number()),
    ownerAddress: v.string(),
    delegatorSmartAccount: v.string(),
    delegateAddress: v.string(),
    treasuryAddress: v.string(),
    settlementContract: v.string(),
    delegationJson: v.string(),
    delegationHash: v.string(),
    delegationExpiresAt: v.optional(v.number()),
    approvalMode: v.union(v.literal('exact'), v.literal('standing')),
    approvalTxHash: v.optional(v.string()),
    createTxHash: v.optional(v.string()),
  },
  returns: delegatedBudgetRecordValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await createDelegatedBudgetInStore(ctx, {
      userId: user._id,
      ...args,
    })
  },
})

export const revokeDelegatedBudget = mutation({
  args: {
    delegatedBudgetId: v.id('delegatedBudgets'),
    revokeTxHash: v.optional(v.string()),
    revocationMode: v.union(
      v.literal('onchain'),
      v.literal('local_retire'),
    ),
    remainingAmountUsdCents: v.number(),
    lastRevokedAt: v.optional(v.number()),
  },
  returns: delegatedBudgetRecordValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await revokeDelegatedBudgetInStore(ctx, {
      userId: user._id,
      ...args,
    })
  },
})

export const refreshDelegatedBudgetState = mutation({
  args: {
    delegatedBudgetId: v.id('delegatedBudgets'),
    status: v.union(
      v.literal('active'),
      v.literal('revoked'),
      v.literal('expired'),
      v.literal('pending'),
    ),
    remainingAmountUsdCents: v.number(),
    periodStartedAt: v.optional(v.number()),
    periodEndsAt: v.optional(v.number()),
    lastSettlementAt: v.optional(v.number()),
    lastRevokedAt: v.optional(v.number()),
    lastSettlementTxHash: v.optional(v.string()),
  },
  returns: delegatedBudgetRecordValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await refreshDelegatedBudgetInStore(ctx, {
      userId: user._id,
      ...args,
    })
  },
})

export const currentDelegatedBudget = query({
  args: {},
  returns: v.union(delegatedBudgetRecordValidator, v.null()),
  handler: async (ctx) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return null
    }

    const budgets = await ctx.db
      .query('delegatedBudgets')
      .withIndex('by_user_and_created_at', (q) => q.eq('userId', user._id))
      .order('desc')
      .take(25)

    return budgets.find((budget) => budget.status === 'active') ?? null
  },
})

export const delegatedBudgetById = query({
  args: {
    delegatedBudgetId: v.id('delegatedBudgets'),
  },
  returns: v.union(delegatedBudgetRecordValidator, v.null()),
  handler: async (ctx, args) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return null
    }

    const budget = await ctx.db.get(args.delegatedBudgetId)

    if (!budget || budget.userId !== user._id) {
      return null
    }

    return budget
  },
})

export const listDelegatedBudgetSettlements = query({
  args: {},
  returns: v.array(delegatedBudgetSettlementValidator),
  handler: async (ctx) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return []
    }

    return await ctx.db
      .query('delegatedBudgetSettlements')
      .withIndex('by_user_and_created_at', (q) => q.eq('userId', user._id))
      .order('desc')
      .take(50)
  },
})

export const recordDelegatedBudgetCharge = mutation({
  args: {
    delegatedBudgetId: v.id('delegatedBudgets'),
    sandboxId: v.optional(v.id('sandboxes')),
    agentPresetId: v.string(),
    eventType: billingEventTypeValidator,
    amountUsdCents: v.number(),
    idempotencyKey: v.string(),
    description: v.string(),
    quantitySummary: v.optional(v.string()),
    settlementId: v.string(),
    txHash: v.string(),
    remainingAmountUsdCents: v.number(),
    periodStartedAt: v.optional(v.number()),
    periodEndsAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    metadataJson: v.optional(v.string()),
  },
  returns: billingChargeValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await recordDelegatedBudgetChargeInStore(ctx, {
      userId: user._id,
      ...args,
    })
  },
})

export const applySubscriptionCreditGrant = mutation({
  args: {
    clerkSubscriptionId: v.string(),
    clerkSubscriptionItemId: v.optional(v.string()),
    status: v.union(
      v.literal('active'),
      v.literal('past_due'),
      v.literal('canceled'),
      v.literal('ended'),
      v.literal('abandoned'),
      v.literal('incomplete'),
      v.literal('upcoming'),
    ),
    planSlug: v.optional(v.string()),
    planName: v.optional(v.string()),
    planPeriod: v.optional(v.union(v.literal('month'), v.literal('annual'))),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    rawJson: v.optional(v.string()),
  },
  returns: v.object({
    wallet: walletValidator,
    currentPlan: currentPlanValidator,
    grantApplied: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const result = await applySubscriptionCreditGrantToWallet(ctx, {
      userId: user._id,
      snapshot: {
        clerkUserId: user.clerkUserId,
        clerkSubscriptionId: args.clerkSubscriptionId,
        clerkSubscriptionItemId: args.clerkSubscriptionItemId,
        status: args.status,
        planSlug: args.planSlug,
        planName: args.planName,
        planPeriod: args.planPeriod,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        rawJson: args.rawJson,
      },
    })
    const wallet = await getWalletSnapshot(ctx, user._id)

    return {
      wallet,
      currentPlan: result.snapshot,
      grantApplied: result.grantApplied,
    }
  },
})

export const syncClerkSubscriptionByClerkUserId = mutation({
  args: {
    clerkUserId: v.string(),
    clerkSubscriptionId: v.string(),
    clerkSubscriptionItemId: v.optional(v.string()),
    status: v.union(
      v.literal('active'),
      v.literal('past_due'),
      v.literal('canceled'),
      v.literal('ended'),
      v.literal('abandoned'),
      v.literal('incomplete'),
      v.literal('upcoming'),
    ),
    planSlug: v.optional(v.string()),
    planName: v.optional(v.string()),
    planPeriod: v.optional(v.union(v.literal('month'), v.literal('annual'))),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    rawJson: v.optional(v.string()),
  },
  returns: v.object({
    matchedUser: v.boolean(),
    grantApplied: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerk_user_id', (q) => q.eq('clerkUserId', args.clerkUserId))
      .unique()

    if (!user) {
      return {
        matchedUser: false,
        grantApplied: false,
      }
    }

    const result = await applySubscriptionCreditGrantToWallet(ctx, {
      userId: user._id,
      snapshot: {
        clerkUserId: args.clerkUserId,
        clerkSubscriptionId: args.clerkSubscriptionId,
        clerkSubscriptionItemId: args.clerkSubscriptionItemId,
        status: args.status,
        planSlug: args.planSlug,
        planName: args.planName,
        planPeriod: args.planPeriod,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        rawJson: args.rawJson,
      },
    })

    return {
      matchedUser: true,
      grantApplied: result.grantApplied,
    }
  },
})

export const expireActiveHolds = internalMutation({
  args: {},
  returns: v.object({
    expiredHoldCount: v.number(),
  }),
  handler: async (ctx) => {
    return await expireActiveCreditHolds(ctx)
  },
})

export const pricingCatalog = query({
  args: {},
  returns: v.object({
    priceVersion: v.string(),
    launchPricesUsdCentsByAgentPreset: v.record(v.string(), v.number()),
    runtimePricesUsdCents: v.object({
      preview_boot: v.number(),
      ssh_access: v.number(),
      web_terminal: v.number(),
    }),
    environment: v.object({
      chainId: v.number(),
      x402Network: v.string(),
      fundingNetwork: v.union(
        v.literal('base-sepolia'),
        v.literal('base-mainnet'),
      ),
      delegatedBudget: v.object({
        enabled: v.boolean(),
        chainId: v.number(),
        network: v.union(
          v.literal('base-sepolia'),
          v.literal('base-mainnet'),
        ),
        tokenAddress: v.string(),
        tokenSymbol: v.literal('USDC'),
        settlementContract: v.string(),
        treasuryAddress: v.string(),
        backendDelegateAddress: v.string(),
        bundlerUrl: v.string(),
      }),
    }),
  }),
  handler: async () => {
    const environment = getBillingEnvironmentConfig()
    const delegatedBudget = getDelegatedBudgetEnvironmentConfig()

    return {
      priceVersion: BILLING_PRICE_VERSION,
      launchPricesUsdCentsByAgentPreset: {
        'general-engineer': getBillingEventPriceUsdCents(
          'general-engineer',
          'sandbox_launch',
        ),
        'frontend-builder': getBillingEventPriceUsdCents(
          'frontend-builder',
          'sandbox_launch',
        ),
        'docs-writer': getBillingEventPriceUsdCents(
          'docs-writer',
          'sandbox_launch',
        ),
        'nansen-analyst': getBillingEventPriceUsdCents(
          'nansen-analyst',
          'sandbox_launch',
        ),
      },
      runtimePricesUsdCents: {
        preview_boot: getUsageEventCostUsdCents(
          'general-engineer',
          'preview_boot',
        ),
        ssh_access: getUsageEventCostUsdCents('general-engineer', 'ssh_access'),
        web_terminal: getUsageEventCostUsdCents(
          'general-engineer',
          'web_terminal',
        ),
      },
      environment: {
        chainId: environment.chainId,
        x402Network: environment.x402Network,
        fundingNetwork: environment.fundingNetwork,
        delegatedBudget,
      },
    }
  },
})
