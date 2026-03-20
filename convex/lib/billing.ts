import { ConvexError } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  BILLING_CURRENCY,
  BILLING_PRICE_VERSION,
  type BillingEventType,
  type DelegatedBudgetInterval,
  type DelegatedBudgetStatus,
  type BillingPaymentRail,
  type ClerkSubscriptionStatus,
  formatUsdCents,
  getDelegatedBudgetEnvironmentConfig,
  getBillingEnvironmentConfig,
  getBillingEventPriceUsdCents,
  getClerkPlanCreditGrantUsdCents,
} from './billingConfig'

type BillingCtx = QueryCtx | MutationCtx

type LegacyWalletSnapshot = {
  availableUsdCents: number
  heldUsdCents: number
  lifetimeCreditedUsdCents: number
  lifetimeSpentUsdCents: number
  fundingAsset: 'USDC'
  fundingNetwork: 'base-sepolia' | 'base-mainnet'
}

type ClerkSnapshotInput = {
  clerkUserId: string
  clerkSubscriptionId: string
  clerkSubscriptionItemId?: string
  status: ClerkSubscriptionStatus
  planSlug?: string
  planName?: string
  planPeriod?: 'month' | 'annual'
  periodStart?: number
  periodEnd?: number
  rawJson?: string
}

type DelegatedBudgetSummary = {
  status: DelegatedBudgetStatus
  type: 'fixed' | 'periodic'
  interval: DelegatedBudgetInterval | null
  token: 'USDC'
  network: 'base-sepolia' | 'base-mainnet'
  configuredAmountUsdCents: number
  remainingAmountUsdCents: number
  periodEndsAt: number | null
  delegatorSmartAccount: string
  delegateAddress: string
  lastSettlementAt: number | null
  lastRevokedAt: number | null
}

function requirePositiveWholeCents(amountUsdCents: number, label: string) {
  if (!Number.isInteger(amountUsdCents) || amountUsdCents <= 0) {
    throw new ConvexError(`${label} must be a whole number of cents greater than zero.`)
  }
}

function requireNonEmptyText(value: string, label: string) {
  if (value.trim().length === 0) {
    throw new ConvexError(`${label} is required.`)
  }
}

function normalizeAddress(value: string) {
  return value.trim().toLowerCase()
}

function buildInsufficientWalletMessage(requiredUsdCents: number) {
  return `Your shared credit wallet needs at least ${formatUsdCents(requiredUsdCents)} available before this action can continue.`
}

function buildMissingDelegatedBudgetMessage() {
  return 'Set up an active MetaMask delegated budget before using this payment rail.'
}

function mapDelegatedBudgetDocToSummary(
  budget: Doc<'delegatedBudgets'>,
): DelegatedBudgetSummary {
  return {
    status: budget.status,
    type: budget.budgetType,
    interval: budget.interval ?? null,
    token: budget.token,
    network: budget.network,
    configuredAmountUsdCents: budget.configuredAmountUsdCents,
    remainingAmountUsdCents: budget.remainingAmountUsdCents,
    periodEndsAt: budget.periodEndsAt ?? null,
    delegatorSmartAccount: budget.delegatorSmartAccount,
    delegateAddress: budget.delegateAddress,
    lastSettlementAt: budget.lastSettlementAt ?? null,
    lastRevokedAt: budget.lastRevokedAt ?? null,
  }
}

async function insertLedgerEntry(
  ctx: MutationCtx,
  entry: {
    userId: Id<'users'>
    accountId: Id<'creditAccounts'>
    sandboxId?: Id<'sandboxes'>
    holdId?: Id<'creditHolds'>
    chargeId?: Id<'billingCharges'>
    paymentRail: BillingPaymentRail
    referenceType:
      | 'migration_opening'
      | 'subscription_grant'
      | 'manual_grant'
      | 'hold_created'
      | 'hold_released'
      | 'hold_captured'
      | 'x402_charge'
      | 'delegated_budget_charge'
    amountUsdCents: number
    balanceDeltaAvailableUsdCents: number
    balanceDeltaHeldUsdCents: number
    description: string
    createdAt?: number
  },
) {
  await ctx.db.insert('creditLedgerEntries', {
    userId: entry.userId,
    accountId: entry.accountId,
    ...(entry.sandboxId ? { sandboxId: entry.sandboxId } : {}),
    ...(entry.holdId ? { holdId: entry.holdId } : {}),
    ...(entry.chargeId ? { chargeId: entry.chargeId } : {}),
    paymentRail: entry.paymentRail,
    referenceType: entry.referenceType,
    amountUsdCents: entry.amountUsdCents,
    balanceDeltaAvailableUsdCents: entry.balanceDeltaAvailableUsdCents,
    balanceDeltaHeldUsdCents: entry.balanceDeltaHeldUsdCents,
    description: entry.description,
    createdAt: entry.createdAt ?? Date.now(),
  })
}

async function patchSandboxBilling(
  ctx: MutationCtx,
  args: {
    sandboxId?: Id<'sandboxes'>
    accountId?: Id<'creditAccounts'>
    chargeId?: Id<'billingCharges'>
    additionalUsdCents: number
    now: number
  },
) {
  if (!args.sandboxId || args.additionalUsdCents <= 0) {
    return
  }

  const sandbox = await ctx.db.get(args.sandboxId)

  if (!sandbox) {
    return
  }

  await ctx.db.patch(args.sandboxId, {
    ...(args.accountId ? { billingAccountId: args.accountId } : {}),
    ...(args.chargeId ? { lastChargeId: args.chargeId } : {}),
    billedUsdCents: (sandbox.billedUsdCents ?? 0) + args.additionalUsdCents,
    lastBilledAt: args.now,
    updatedAt: args.now,
  })
}

export async function getCreditAccount(
  ctx: BillingCtx,
  userId: Id<'users'>,
): Promise<Doc<'creditAccounts'> | null> {
  const environmentConfig = getBillingEnvironmentConfig()

  return await ctx.db
    .query('creditAccounts')
    .withIndex('by_user_and_environment', (q) =>
      q.eq('userId', userId).eq('environment', environmentConfig.environment),
    )
    .unique()
}

async function getLegacyWalletSnapshot(
  ctx: BillingCtx,
  userId: Id<'users'>,
): Promise<LegacyWalletSnapshot> {
  const environmentConfig = getBillingEnvironmentConfig()
  const legacyAccount = await ctx.db
    .query('billingAccounts')
    .withIndex('by_user_and_currency', (q) =>
      q.eq('userId', userId).eq('currency', BILLING_CURRENCY),
    )
    .unique()
  const legacyReserves = await ctx.db
    .query('agentReserves')
    .withIndex('by_user_and_agent_preset_id', (q) => q.eq('userId', userId))
    .collect()
  const activeLegacyLeases = await ctx.db
    .query('reserveLeases')
    .withIndex('by_user_and_status', (q) =>
      q.eq('userId', userId).eq('status', 'active'),
    )
    .collect()
  const availableFromReserves = legacyReserves.reduce(
    (total, reserve) => total + reserve.availableUsdCents,
    0,
  )
  const heldFromLeases = activeLegacyLeases.reduce(
    (total, lease) => total + lease.amountUsdCents,
    0,
  )
  const spentFromReserves = legacyReserves.reduce(
    (total, reserve) => total + reserve.spentUsdCentsLifetime,
    0,
  )
  const availableUsdCents =
    (legacyAccount?.unallocatedUsdCents ?? 0) + availableFromReserves
  const heldUsdCents = heldFromLeases
  const lifetimeSpentUsdCents = spentFromReserves
  const lifetimeCreditedUsdCents = Math.max(
    legacyAccount?.fundedUsdCents ?? 0,
    availableUsdCents + heldUsdCents + lifetimeSpentUsdCents,
  )

  return {
    availableUsdCents,
    heldUsdCents,
    lifetimeCreditedUsdCents,
    lifetimeSpentUsdCents,
    fundingAsset: 'USDC',
    fundingNetwork: environmentConfig.fundingNetwork,
  }
}

async function findFirstChargeForHold(
  ctx: BillingCtx,
  holdId: Id<'creditHolds'>,
): Promise<Doc<'billingCharges'> | null> {
  const charges = await ctx.db
    .query('billingCharges')
    .withIndex('by_hold_id', (q) => q.eq('holdId', holdId))
    .take(1)

  return charges[0] ?? null
}

async function migrateLegacyActiveLeases(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    accountId: Id<'creditAccounts'>
  },
) {
  const activeLegacyLeases = await ctx.db
    .query('reserveLeases')
    .withIndex('by_user_and_status', (q) =>
      q.eq('userId', args.userId).eq('status', 'active'),
    )
    .collect()

  for (const lease of activeLegacyLeases) {
    const migrationReference = `reserveLease:${lease._id}`
    const existingHold = await ctx.db
      .query('creditHolds')
      .withIndex('by_migration_reference', (q) =>
        q.eq('migrationReference', migrationReference),
      )
      .unique()

    if (existingHold) {
      continue
    }

    const reserve = await ctx.db.get(lease.agentReserveId)
    const sandbox = lease.sandboxId ? await ctx.db.get(lease.sandboxId) : null

    await ctx.db.insert('creditHolds', {
      userId: args.userId,
      accountId: args.accountId,
      ...(lease.sandboxId ? { sandboxId: lease.sandboxId } : {}),
      agentPresetId:
        sandbox?.agentPresetId ?? reserve?.agentPresetId ?? 'general-engineer',
      purpose: lease.purpose,
      amountUsdCents: lease.amountUsdCents,
      sourcePaymentRail: 'migration',
      status: 'active',
      expiresAt: lease.expiresAt,
      idempotencyKey: `migrated:${lease.idempotencyKey}`,
      migrationReference,
      ...(lease.metadataJson ? { quantitySummary: lease.metadataJson } : {}),
      description: `Migrated legacy hold for ${lease.purpose}`,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    })
  }
}

export async function getOrCreateCreditAccount(
  ctx: MutationCtx,
  userId: Id<'users'>,
): Promise<Doc<'creditAccounts'>> {
  const existing = await getCreditAccount(ctx, userId)

  if (existing) {
    await migrateLegacyActiveLeases(ctx, {
      userId,
      accountId: existing._id,
    })
    return existing
  }

  const environmentConfig = getBillingEnvironmentConfig()
  const legacySnapshot = await getLegacyWalletSnapshot(ctx, userId)
  const now = Date.now()
  const accountId = await ctx.db.insert('creditAccounts', {
    userId,
    currency: BILLING_CURRENCY,
    environment: environmentConfig.environment,
    fundingAsset: legacySnapshot.fundingAsset,
    fundingNetwork: legacySnapshot.fundingNetwork,
    availableUsdCents: legacySnapshot.availableUsdCents,
    heldUsdCents: legacySnapshot.heldUsdCents,
    lifetimeCreditedUsdCents: legacySnapshot.lifetimeCreditedUsdCents,
    lifetimeSpentUsdCents: legacySnapshot.lifetimeSpentUsdCents,
    createdAt: now,
    updatedAt: now,
  })
  const account = await ctx.db.get(accountId)

  if (!account) {
    throw new ConvexError('Failed to create the shared credit wallet.')
  }

  if (
    legacySnapshot.availableUsdCents > 0 ||
    legacySnapshot.heldUsdCents > 0 ||
    legacySnapshot.lifetimeCreditedUsdCents > 0
  ) {
    await insertLedgerEntry(ctx, {
      userId,
      accountId,
      paymentRail: 'migration',
      referenceType: 'migration_opening',
      amountUsdCents:
        legacySnapshot.availableUsdCents + legacySnapshot.heldUsdCents,
      balanceDeltaAvailableUsdCents: legacySnapshot.availableUsdCents,
      balanceDeltaHeldUsdCents: legacySnapshot.heldUsdCents,
      description: 'Migrated legacy funding and active holds into the shared wallet.',
      createdAt: now,
    })
  }

  await migrateLegacyActiveLeases(ctx, {
    userId,
    accountId,
  })

  return account
}

export async function getWalletSnapshot(
  ctx: BillingCtx,
  userId: Id<'users'>,
) {
  const environmentConfig = getBillingEnvironmentConfig()
  const account = await getCreditAccount(ctx, userId)

  if (account) {
    return {
      ...(account ? { accountId: account._id } : {}),
      currency: account.currency,
      availableUsdCents: account.availableUsdCents,
      heldUsdCents: account.heldUsdCents,
      lifetimeCreditedUsdCents: account.lifetimeCreditedUsdCents,
      lifetimeSpentUsdCents: account.lifetimeSpentUsdCents,
      fundingAsset: account.fundingAsset,
      fundingNetwork: account.fundingNetwork,
      environment: account.environment,
      chainId: environmentConfig.chainId,
      x402Network: environmentConfig.x402Network,
    }
  }

  const legacySnapshot = await getLegacyWalletSnapshot(ctx, userId)

  return {
    accountId: undefined,
    currency: BILLING_CURRENCY,
    availableUsdCents: legacySnapshot.availableUsdCents,
    heldUsdCents: legacySnapshot.heldUsdCents,
    lifetimeCreditedUsdCents: legacySnapshot.lifetimeCreditedUsdCents,
    lifetimeSpentUsdCents: legacySnapshot.lifetimeSpentUsdCents,
    fundingAsset: legacySnapshot.fundingAsset,
    fundingNetwork: legacySnapshot.fundingNetwork,
    environment: environmentConfig.environment,
    chainId: environmentConfig.chainId,
    x402Network: environmentConfig.x402Network,
  }
}

export async function getActiveDelegatedBudget(
  ctx: BillingCtx,
  userId: Id<'users'>,
) {
  const recentBudgets = await ctx.db
    .query('delegatedBudgets')
    .withIndex('by_user_and_created_at', (q) => q.eq('userId', userId))
    .order('desc')
    .take(25)

  return recentBudgets.find((budget) => budget.status === 'active') ?? null
}

export async function getDelegatedBudgetSummary(
  ctx: BillingCtx,
  userId: Id<'users'>,
) {
  const budget = await getActiveDelegatedBudget(ctx, userId)
  return budget ? mapDelegatedBudgetDocToSummary(budget) : null
}

async function summarizeAvailableBalanceByRail(
  ctx: BillingCtx,
  accountId: Id<'creditAccounts'>,
) {
  const ledgerEntries = await ctx.db
    .query('creditLedgerEntries')
    .withIndex('by_account_and_created_at', (q) => q.eq('accountId', accountId))
    .collect()
  const balances: Record<BillingPaymentRail, number> = {
    clerk_credit: 0,
    x402_direct: 0,
    metamask_delegated: 0,
    migration: 0,
    manual_test: 0,
  }

  for (const entry of ledgerEntries) {
    balances[entry.paymentRail] += entry.balanceDeltaAvailableUsdCents
  }

  return balances
}

async function selectSourceRailForHold(
  ctx: BillingCtx,
  args: {
    accountId: Id<'creditAccounts'>
    amountUsdCents: number
  },
): Promise<'clerk_credit' | 'migration' | 'manual_test'> {
  const balances = await summarizeAvailableBalanceByRail(ctx, args.accountId)
  const preferredRails: Array<'clerk_credit' | 'manual_test' | 'migration'> = [
    'clerk_credit',
    'manual_test',
    'migration',
  ]

  for (const rail of preferredRails) {
    if (balances[rail] >= args.amountUsdCents) {
      return rail
    }
  }

  for (const rail of preferredRails) {
    if (balances[rail] > 0) {
      return rail
    }
  }

  return 'migration'
}

export async function holdCredits(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    sandboxId?: Id<'sandboxes'>
    agentPresetId: string
    purpose: 'sandbox_launch' | 'preview_boot' | 'ssh_access' | 'web_terminal' | 'generic'
    amountUsdCents: number
    idempotencyKey: string
    expiresInSeconds?: number
    quantitySummary?: string
    description?: string
  },
) {
  requirePositiveWholeCents(args.amountUsdCents, 'Credit hold amount')
  requireNonEmptyText(args.idempotencyKey, 'Idempotency key')

  const existingHold = await ctx.db
    .query('creditHolds')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingHold) {
    return existingHold
  }

  const account = await getOrCreateCreditAccount(ctx, args.userId)

  if (account.availableUsdCents < args.amountUsdCents) {
    throw new ConvexError(buildInsufficientWalletMessage(args.amountUsdCents))
  }

  const sourcePaymentRail = await selectSourceRailForHold(ctx, {
    accountId: account._id,
    amountUsdCents: args.amountUsdCents,
  })
  const now = Date.now()
  const holdId = await ctx.db.insert('creditHolds', {
    userId: args.userId,
    accountId: account._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    agentPresetId: args.agentPresetId,
    purpose: args.purpose,
    amountUsdCents: args.amountUsdCents,
    sourcePaymentRail,
    status: 'active',
    expiresAt: now + (args.expiresInSeconds ?? 15 * 60) * 1000,
    idempotencyKey: args.idempotencyKey,
    ...(args.quantitySummary ? { quantitySummary: args.quantitySummary } : {}),
    ...(args.description ? { description: args.description } : {}),
    createdAt: now,
    updatedAt: now,
  })

  await ctx.db.patch(account._id, {
    availableUsdCents: account.availableUsdCents - args.amountUsdCents,
    heldUsdCents: account.heldUsdCents + args.amountUsdCents,
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    holdId,
    paymentRail: sourcePaymentRail,
    referenceType: 'hold_created',
    amountUsdCents: args.amountUsdCents,
    balanceDeltaAvailableUsdCents: -args.amountUsdCents,
    balanceDeltaHeldUsdCents: args.amountUsdCents,
    description: args.description ?? `Hold credits for ${args.purpose}`,
    createdAt: now,
  })

  const hold = await ctx.db.get(holdId)

  if (!hold) {
    throw new ConvexError('The credit hold was created but could not be reloaded.')
  }

  return hold
}

export async function releaseCreditHold(
  ctx: MutationCtx,
  args: {
    holdId: Id<'creditHolds'>
    reason: string
  },
) {
  requireNonEmptyText(args.reason, 'Release reason')

  const hold = await ctx.db.get(args.holdId)

  if (!hold) {
    throw new ConvexError('Credit hold not found.')
  }

  if (hold.status !== 'active') {
    return hold
  }

  const account = await ctx.db.get(hold.accountId)

  if (!account) {
    throw new ConvexError('The shared credit wallet for this hold no longer exists.')
  }

  const now = Date.now()

  await ctx.db.patch(hold._id, {
    status: 'released',
    description: args.reason,
    releasedAt: now,
    updatedAt: now,
  })
  await ctx.db.patch(account._id, {
    availableUsdCents: account.availableUsdCents + hold.amountUsdCents,
    heldUsdCents: account.heldUsdCents - hold.amountUsdCents,
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: hold.userId,
    accountId: account._id,
    ...(hold.sandboxId ? { sandboxId: hold.sandboxId } : {}),
    holdId: hold._id,
    paymentRail: hold.sourcePaymentRail,
    referenceType: 'hold_released',
    amountUsdCents: hold.amountUsdCents,
    balanceDeltaAvailableUsdCents: hold.amountUsdCents,
    balanceDeltaHeldUsdCents: -hold.amountUsdCents,
    description: args.reason,
    createdAt: now,
  })

  const updatedHold = await ctx.db.get(hold._id)

  if (!updatedHold) {
    throw new ConvexError('The released credit hold could not be reloaded.')
  }

  return updatedHold
}

export async function captureCreditHold(
  ctx: MutationCtx,
  args: {
    holdId: Id<'creditHolds'>
    sandboxId?: Id<'sandboxes'>
    eventType: BillingEventType
    idempotencyKey: string
    description: string
    quantitySummary?: string
    costUsdCents?: number
  },
) {
  requireNonEmptyText(args.idempotencyKey, 'Idempotency key')
  requireNonEmptyText(args.description, 'Charge description')

  const existingCharge = await ctx.db
    .query('billingCharges')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingCharge) {
    return existingCharge
  }

  const hold = await ctx.db.get(args.holdId)

  if (!hold) {
    throw new ConvexError('Credit hold not found.')
  }

  const existingHoldCharge = await findFirstChargeForHold(ctx, hold._id)

  if (hold.status === 'captured' && existingHoldCharge) {
    return existingHoldCharge
  }

  if (hold.status !== 'active') {
    throw new ConvexError('Only active holds can be captured.')
  }

  const account = await ctx.db.get(hold.accountId)

  if (!account) {
    throw new ConvexError('The shared credit wallet for this hold no longer exists.')
  }

  const costUsdCents = args.costUsdCents ?? hold.amountUsdCents

  if (costUsdCents !== hold.amountUsdCents) {
    throw new ConvexError('Hold captures must match the reserved amount exactly.')
  }

  const now = Date.now()
  const chargeId = await ctx.db.insert('billingCharges', {
    userId: hold.userId,
    accountId: hold.accountId,
    ...(args.sandboxId ?? hold.sandboxId ? { sandboxId: args.sandboxId ?? hold.sandboxId } : {}),
    holdId: hold._id,
    agentPresetId: hold.agentPresetId,
    eventType: args.eventType,
    paymentRail: hold.sourcePaymentRail,
    amountUsdCents: costUsdCents,
    unitPriceVersion: BILLING_PRICE_VERSION,
    ...(args.quantitySummary ?? hold.quantitySummary
      ? { quantitySummary: args.quantitySummary ?? hold.quantitySummary }
      : {}),
    description: args.description,
    idempotencyKey: args.idempotencyKey,
    createdAt: now,
  })

  await ctx.db.patch(hold._id, {
    status: 'captured',
    description: args.description,
    ...(args.quantitySummary ? { quantitySummary: args.quantitySummary } : {}),
    capturedAt: now,
    updatedAt: now,
  })
  await ctx.db.patch(account._id, {
    heldUsdCents: account.heldUsdCents - costUsdCents,
    lifetimeSpentUsdCents: account.lifetimeSpentUsdCents + costUsdCents,
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: hold.userId,
    accountId: account._id,
    ...(args.sandboxId ?? hold.sandboxId
      ? { sandboxId: args.sandboxId ?? hold.sandboxId }
      : {}),
    holdId: hold._id,
    chargeId,
    paymentRail: hold.sourcePaymentRail,
    referenceType: 'hold_captured',
    amountUsdCents: costUsdCents,
    balanceDeltaAvailableUsdCents: 0,
    balanceDeltaHeldUsdCents: -costUsdCents,
    description: args.description,
    createdAt: now,
  })

  await patchSandboxBilling(ctx, {
    sandboxId: args.sandboxId ?? hold.sandboxId,
    accountId: account._id,
    chargeId,
    additionalUsdCents: costUsdCents,
    now,
  })

  const charge = await ctx.db.get(chargeId)

  if (!charge) {
    throw new ConvexError('The billing charge could not be reloaded after capture.')
  }

  return charge
}

export async function expireActiveCreditHolds(ctx: MutationCtx) {
  const now = Date.now()
  const expiredHolds = await ctx.db
    .query('creditHolds')
    .withIndex('by_status_and_expires_at', (q) =>
      q.eq('status', 'active').lt('expiresAt', now),
    )
    .take(50)

  for (const hold of expiredHolds) {
    await releaseCreditHold(ctx, {
      holdId: hold._id,
      reason: `Credit hold expired at ${new Date(hold.expiresAt).toISOString()}`,
    })
  }

  return {
    expiredHoldCount: expiredHolds.length,
  }
}

export async function recordX402Charge(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    sandboxId?: Id<'sandboxes'>
    agentPresetId: string
    eventType: BillingEventType
    amountUsdCents: number
    idempotencyKey: string
    description: string
    quantitySummary?: string
    externalReference: string
    metadataJson?: string
  },
) {
  requirePositiveWholeCents(args.amountUsdCents, 'x402 charge amount')
  requireNonEmptyText(args.idempotencyKey, 'Idempotency key')
  requireNonEmptyText(args.description, 'Charge description')
  requireNonEmptyText(args.externalReference, 'External settlement reference')

  const existingCharge = await ctx.db
    .query('billingCharges')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingCharge) {
    return existingCharge
  }

  const account = await getOrCreateCreditAccount(ctx, args.userId)
  const now = Date.now()
  const chargeId = await ctx.db.insert('billingCharges', {
    userId: args.userId,
    accountId: account._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    agentPresetId: args.agentPresetId,
    eventType: args.eventType,
    paymentRail: 'x402_direct',
    amountUsdCents: args.amountUsdCents,
    unitPriceVersion: BILLING_PRICE_VERSION,
    ...(args.quantitySummary ? { quantitySummary: args.quantitySummary } : {}),
    description: args.description,
    idempotencyKey: args.idempotencyKey,
    externalReference: args.externalReference,
    ...(args.metadataJson ? { metadataJson: args.metadataJson } : {}),
    createdAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    chargeId,
    paymentRail: 'x402_direct',
    referenceType: 'x402_charge',
    amountUsdCents: args.amountUsdCents,
    balanceDeltaAvailableUsdCents: 0,
    balanceDeltaHeldUsdCents: 0,
    description: args.description,
    createdAt: now,
  })

  await patchSandboxBilling(ctx, {
    sandboxId: args.sandboxId,
    accountId: account._id,
    chargeId,
    additionalUsdCents: args.amountUsdCents,
    now,
  })

  const charge = await ctx.db.get(chargeId)

  if (!charge) {
    throw new ConvexError('The x402 charge could not be reloaded after it was recorded.')
  }

  return charge
}

export async function createDelegatedBudget(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    contractBudgetId: string
    budgetType: 'fixed' | 'periodic'
    interval?: DelegatedBudgetInterval
    configuredAmountUsdCents: number
    remainingAmountUsdCents: number
    periodStartedAt?: number
    periodEndsAt?: number
    ownerAddress: string
    delegatorSmartAccount: string
    delegateAddress: string
    treasuryAddress: string
    delegationJson: string
    delegationHash: string
    delegationExpiresAt?: number
    approvalMode: 'exact' | 'standing'
    approvalTxHash?: string
    createTxHash?: string
  },
) {
  requirePositiveWholeCents(
    args.configuredAmountUsdCents,
    'Delegated budget amount',
  )
  if (
    !Number.isInteger(args.remainingAmountUsdCents) ||
    args.remainingAmountUsdCents !== args.configuredAmountUsdCents
  ) {
    throw new ConvexError(
      'New delegated budgets must start with their full configured allowance remaining.',
    )
  }
  requireNonEmptyText(args.contractBudgetId, 'Delegated budget ID')
  requireNonEmptyText(args.ownerAddress, 'Budget owner address')
  requireNonEmptyText(
    args.delegatorSmartAccount,
    'Delegator smart account address',
  )
  requireNonEmptyText(args.delegateAddress, 'Backend delegate address')
  requireNonEmptyText(args.treasuryAddress, 'Delegated-budget treasury address')
  requireNonEmptyText(args.delegationJson, 'Delegation payload')
  requireNonEmptyText(args.delegationHash, 'Delegation hash')

  const existingBudget = await ctx.db
    .query('delegatedBudgets')
    .withIndex('by_contract_budget_id', (q) =>
      q.eq('contractBudgetId', args.contractBudgetId),
    )
    .unique()

  if (existingBudget) {
    return existingBudget
  }

  const activeBudget = await getActiveDelegatedBudget(ctx, args.userId)

  if (activeBudget) {
    throw new ConvexError(
      'Revoke your current delegated budget before creating a new one.',
    )
  }

  const account = await getCreditAccount(ctx, args.userId)
  const delegatedBudgetConfig = getDelegatedBudgetEnvironmentConfig()

  if (!delegatedBudgetConfig.enabled) {
    throw new ConvexError(
      'Delegated budgets are not configured in this environment yet.',
    )
  }

  if (
    normalizeAddress(args.delegateAddress) !==
    normalizeAddress(delegatedBudgetConfig.backendDelegateAddress)
  ) {
    throw new ConvexError(
      'The delegated budget was signed for a different backend delegate.',
    )
  }

  if (
    normalizeAddress(args.treasuryAddress) !==
    normalizeAddress(delegatedBudgetConfig.treasuryAddress)
  ) {
    throw new ConvexError(
      'The delegated budget treasury does not match the configured BuddyPie treasury.',
    )
  }

  const now = Date.now()

  if (
    typeof args.delegationExpiresAt === 'number' &&
    args.delegationExpiresAt <= now
  ) {
    throw new ConvexError(
      'The signed delegated budget has already expired. Create a fresh budget.',
    )
  }

  const budgetId = await ctx.db.insert('delegatedBudgets', {
    userId: args.userId,
    ...(account ? { accountId: account._id } : {}),
    status: 'active',
    budgetType: args.budgetType,
    ...(args.interval ? { interval: args.interval } : {}),
    token: 'USDC',
    network: delegatedBudgetConfig.network,
    configuredAmountUsdCents: args.configuredAmountUsdCents,
    remainingAmountUsdCents: args.remainingAmountUsdCents,
    ...(args.periodStartedAt ? { periodStartedAt: args.periodStartedAt } : {}),
    ...(args.periodEndsAt ? { periodEndsAt: args.periodEndsAt } : {}),
    ownerAddress: args.ownerAddress,
    delegatorSmartAccount: args.delegatorSmartAccount,
    delegateAddress: args.delegateAddress,
    treasuryAddress: args.treasuryAddress,
    ...(delegatedBudgetConfig.settlementContract
      ? { settlementContract: delegatedBudgetConfig.settlementContract }
      : {}),
    contractBudgetId: args.contractBudgetId,
    delegationJson: args.delegationJson,
    delegationHash: args.delegationHash,
    ...(args.delegationExpiresAt
      ? { delegationExpiresAt: args.delegationExpiresAt }
      : {}),
    approvalMode: args.approvalMode,
    ...(args.approvalTxHash ? { approvalTxHash: args.approvalTxHash } : {}),
    ...(args.createTxHash ? { createTxHash: args.createTxHash } : {}),
    createdAt: now,
    updatedAt: now,
  })
  const budget = await ctx.db.get(budgetId)

  if (!budget) {
    throw new ConvexError('The delegated budget could not be reloaded.')
  }

  return budget
}

export async function revokeDelegatedBudget(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    delegatedBudgetId: Id<'delegatedBudgets'>
    revokeTxHash?: string
    revocationMode: 'onchain' | 'local_retire'
    remainingAmountUsdCents: number
    lastRevokedAt?: number
  },
) {
  if (args.revocationMode === 'onchain') {
    requireNonEmptyText(args.revokeTxHash ?? '', 'Revoke transaction hash')
  }

  const budget = await ctx.db.get(args.delegatedBudgetId)

  if (!budget || budget.userId !== args.userId) {
    throw new ConvexError('Delegated budget not found.')
  }

  const revokedAt = args.lastRevokedAt ?? Date.now()

  await ctx.db.patch(budget._id, {
    status: 'revoked',
    remainingAmountUsdCents: args.remainingAmountUsdCents,
    lastRevokedAt: revokedAt,
    ...(args.revokeTxHash ? { revokeTxHash: args.revokeTxHash } : {}),
    revocationMode: args.revocationMode,
    updatedAt: revokedAt,
  })

  const updatedBudget = await ctx.db.get(budget._id)

  if (!updatedBudget) {
    throw new ConvexError('The delegated budget could not be reloaded.')
  }

  return updatedBudget
}

export async function refreshDelegatedBudget(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    delegatedBudgetId: Id<'delegatedBudgets'>
    status: DelegatedBudgetStatus
    remainingAmountUsdCents: number
    periodStartedAt?: number
    periodEndsAt?: number
    lastSettlementAt?: number
    lastRevokedAt?: number
    lastSettlementTxHash?: string
  },
) {
  const budget = await ctx.db.get(args.delegatedBudgetId)

  if (!budget || budget.userId !== args.userId) {
    throw new ConvexError('Delegated budget not found.')
  }

  await ctx.db.patch(budget._id, {
    status: args.status,
    remainingAmountUsdCents: args.remainingAmountUsdCents,
    ...(args.periodStartedAt ? { periodStartedAt: args.periodStartedAt } : {}),
    ...(args.periodEndsAt ? { periodEndsAt: args.periodEndsAt } : {}),
    ...(args.lastSettlementAt
      ? { lastSettlementAt: args.lastSettlementAt }
      : {}),
    ...(args.lastRevokedAt ? { lastRevokedAt: args.lastRevokedAt } : {}),
    ...(args.lastSettlementTxHash
      ? { lastSettlementTxHash: args.lastSettlementTxHash }
      : {}),
    updatedAt: Date.now(),
  })

  const updatedBudget = await ctx.db.get(budget._id)

  if (!updatedBudget) {
    throw new ConvexError('The delegated budget could not be refreshed.')
  }

  return updatedBudget
}

export async function recordDelegatedBudgetCharge(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    delegatedBudgetId: Id<'delegatedBudgets'>
    sandboxId?: Id<'sandboxes'>
    agentPresetId: string
    eventType: BillingEventType
    amountUsdCents: number
    idempotencyKey: string
    description: string
    quantitySummary?: string
    settlementId: string
    txHash: string
    remainingAmountUsdCents: number
    periodStartedAt?: number
    periodEndsAt?: number
    settledAt?: number
    metadataJson?: string
  },
) {
  requirePositiveWholeCents(
    args.amountUsdCents,
    'Delegated budget charge amount',
  )
  requireNonEmptyText(args.idempotencyKey, 'Idempotency key')
  requireNonEmptyText(args.description, 'Charge description')
  requireNonEmptyText(args.settlementId, 'Settlement ID')
  requireNonEmptyText(args.txHash, 'Settlement transaction hash')

  const existingCharge = await ctx.db
    .query('billingCharges')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingCharge) {
    return existingCharge
  }

  const budget = await ctx.db.get(args.delegatedBudgetId)

  if (!budget || budget.userId !== args.userId) {
    throw new ConvexError(buildMissingDelegatedBudgetMessage())
  }

  if (budget.status !== 'active') {
    throw new ConvexError(buildMissingDelegatedBudgetMessage())
  }

  const account = await getOrCreateCreditAccount(ctx, args.userId)
  const settledAt = args.settledAt ?? Date.now()
  const chargeId = await ctx.db.insert('billingCharges', {
    userId: args.userId,
    accountId: account._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    agentPresetId: args.agentPresetId,
    eventType: args.eventType,
    paymentRail: 'metamask_delegated',
    amountUsdCents: args.amountUsdCents,
    unitPriceVersion: BILLING_PRICE_VERSION,
    ...(args.quantitySummary ? { quantitySummary: args.quantitySummary } : {}),
    description: args.description,
    idempotencyKey: args.idempotencyKey,
    externalReference: args.txHash,
    ...(args.metadataJson ? { metadataJson: args.metadataJson } : {}),
    createdAt: settledAt,
  })

  await ctx.db.insert('delegatedBudgetSettlements', {
    userId: args.userId,
    delegatedBudgetId: budget._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    chargeId,
    agentPresetId: args.agentPresetId,
    eventType: args.eventType,
    paymentRail: 'metamask_delegated',
    amountUsdCents: args.amountUsdCents,
    contractBudgetId: budget.contractBudgetId,
    settlementId: args.settlementId,
    txHash: args.txHash,
    remainingAmountUsdCents: args.remainingAmountUsdCents,
    ...(args.periodStartedAt ? { periodStartedAt: args.periodStartedAt } : {}),
    ...(args.periodEndsAt ? { periodEndsAt: args.periodEndsAt } : {}),
    idempotencyKey: args.idempotencyKey,
    createdAt: settledAt,
  })

  await ctx.db.patch(budget._id, {
    remainingAmountUsdCents: args.remainingAmountUsdCents,
    ...(args.periodStartedAt ? { periodStartedAt: args.periodStartedAt } : {}),
    ...(args.periodEndsAt ? { periodEndsAt: args.periodEndsAt } : {}),
    lastSettlementAt: settledAt,
    lastSettlementTxHash: args.txHash,
    updatedAt: settledAt,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    chargeId,
    paymentRail: 'metamask_delegated',
    referenceType: 'delegated_budget_charge',
    amountUsdCents: args.amountUsdCents,
    balanceDeltaAvailableUsdCents: 0,
    balanceDeltaHeldUsdCents: 0,
    description: args.description,
    createdAt: settledAt,
  })

  await patchSandboxBilling(ctx, {
    sandboxId: args.sandboxId,
    accountId: account._id,
    chargeId,
    additionalUsdCents: args.amountUsdCents,
    now: settledAt,
  })

  const charge = await ctx.db.get(chargeId)

  if (!charge) {
    throw new ConvexError(
      'The delegated budget charge could not be reloaded after it was recorded.',
    )
  }

  return charge
}

async function upsertClerkSubscriptionSnapshot(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    snapshot: ClerkSnapshotInput
  },
) {
  const now = Date.now()
  const existingSnapshot = await ctx.db
    .query('clerkSubscriptionSnapshots')
    .withIndex('by_clerk_subscription_id', (q) =>
      q.eq('clerkSubscriptionId', args.snapshot.clerkSubscriptionId),
    )
    .unique()

  const snapshotFields = {
    userId: args.userId,
    clerkUserId: args.snapshot.clerkUserId,
    clerkSubscriptionId: args.snapshot.clerkSubscriptionId,
    ...(args.snapshot.clerkSubscriptionItemId
      ? { clerkSubscriptionItemId: args.snapshot.clerkSubscriptionItemId }
      : {}),
    status: args.snapshot.status,
    ...(args.snapshot.planSlug ? { planSlug: args.snapshot.planSlug } : {}),
    ...(args.snapshot.planName ? { planName: args.snapshot.planName } : {}),
    ...(args.snapshot.planPeriod ? { planPeriod: args.snapshot.planPeriod } : {}),
    payerType: 'user' as const,
    ...(args.snapshot.periodStart ? { periodStart: args.snapshot.periodStart } : {}),
    ...(args.snapshot.periodEnd ? { periodEnd: args.snapshot.periodEnd } : {}),
    ...(args.snapshot.rawJson ? { rawJson: args.snapshot.rawJson } : {}),
    updatedAt: now,
  }

  if (existingSnapshot) {
    await ctx.db.patch(existingSnapshot._id, snapshotFields)
    const snapshot = await ctx.db.get(existingSnapshot._id)

    if (!snapshot) {
      throw new ConvexError('The Clerk subscription snapshot could not be reloaded.')
    }

    return snapshot
  }

  const snapshotId = await ctx.db.insert('clerkSubscriptionSnapshots', {
    ...snapshotFields,
    createdAt: now,
  })
  const snapshot = await ctx.db.get(snapshotId)

  if (!snapshot) {
    throw new ConvexError('The Clerk subscription snapshot could not be created.')
  }

  return snapshot
}

export async function applySubscriptionCreditGrant(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    snapshot: ClerkSnapshotInput
  },
) {
  const snapshot = await upsertClerkSubscriptionSnapshot(ctx, args)
  const account = await getOrCreateCreditAccount(ctx, args.userId)
  const grantAmountUsdCents = getClerkPlanCreditGrantUsdCents({
    planSlug: args.snapshot.planSlug,
    planPeriod: args.snapshot.planPeriod,
  })

  if (
    args.snapshot.status !== 'active' ||
    !args.snapshot.clerkSubscriptionItemId ||
    !args.snapshot.periodStart ||
    grantAmountUsdCents <= 0
  ) {
    return {
      account,
      snapshot,
      grantApplied: false,
      grant: null,
    }
  }

  const grantIdempotencyKey = [
    args.snapshot.clerkSubscriptionItemId,
    args.snapshot.periodStart,
    args.snapshot.periodEnd ?? 'open',
  ].join(':')
  const existingGrant = await ctx.db
    .query('subscriptionCreditGrants')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', grantIdempotencyKey))
    .unique()

  if (existingGrant) {
    return {
      account,
      snapshot,
      grantApplied: false,
      grant: existingGrant,
    }
  }

  const now = Date.now()
  const grantId = await ctx.db.insert('subscriptionCreditGrants', {
    userId: args.userId,
    accountId: account._id,
    clerkSubscriptionId: args.snapshot.clerkSubscriptionId,
    clerkSubscriptionItemId: args.snapshot.clerkSubscriptionItemId,
    ...(args.snapshot.planSlug ? { planSlug: args.snapshot.planSlug } : {}),
    ...(args.snapshot.planPeriod ? { planPeriod: args.snapshot.planPeriod } : {}),
    paymentRail: 'clerk_credit',
    amountUsdCents: grantAmountUsdCents,
    periodStart: args.snapshot.periodStart,
    ...(args.snapshot.periodEnd ? { periodEnd: args.snapshot.periodEnd } : {}),
    idempotencyKey: grantIdempotencyKey,
    snapshotId: snapshot._id,
    createdAt: now,
    appliedAt: now,
  })

  await ctx.db.patch(account._id, {
    availableUsdCents: account.availableUsdCents + grantAmountUsdCents,
    lifetimeCreditedUsdCents:
      account.lifetimeCreditedUsdCents + grantAmountUsdCents,
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    paymentRail: 'clerk_credit',
    referenceType: 'subscription_grant',
    amountUsdCents: grantAmountUsdCents,
    balanceDeltaAvailableUsdCents: grantAmountUsdCents,
    balanceDeltaHeldUsdCents: 0,
    description: `Clerk subscription credit grant for ${args.snapshot.planSlug ?? 'active plan'}`,
    createdAt: now,
  })

  const updatedAccount = await ctx.db.get(account._id)
  const grant = await ctx.db.get(grantId)

  if (!updatedAccount || !grant) {
    throw new ConvexError('The subscription credit grant could not be reloaded.')
  }

  return {
    account: updatedAccount,
    snapshot,
    grantApplied: true,
    grant,
  }
}

export async function getCurrentPlanSnapshot(
  ctx: BillingCtx,
  userId: Id<'users'>,
) {
  const snapshots = await ctx.db
    .query('clerkSubscriptionSnapshots')
    .withIndex('by_user_and_updated_at', (q) => q.eq('userId', userId))
    .order('desc')
    .take(1)

  return snapshots[0] ?? null
}

export async function getSandboxCharges(
  ctx: BillingCtx,
  sandboxId: Id<'sandboxes'>,
) {
  return await ctx.db
    .query('billingCharges')
    .withIndex('by_sandbox_and_created_at', (q) => q.eq('sandboxId', sandboxId))
    .order('desc')
    .take(20)
}

export function getUsageEventCostUsdCents(
  agentPresetId: string,
  eventType: BillingEventType,
) {
  return getBillingEventPriceUsdCents(agentPresetId, eventType)
}
