import { ConvexError } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export const BILLING_CURRENCY = 'USD' as const
export const BILLING_ASSET = 'USDC' as const
export const BILLING_NETWORK = 'base-sepolia' as const
export const BILLING_ENVIRONMENT = 'prod' as const
export const BILLING_PRICE_VERSION = 'buddy_x402_2026_03_16_v1'

export const reserveLeasePurposeValues = [
  'sandbox_launch',
  'preview_boot',
  'ssh_access',
  'web_terminal',
  'generic',
] as const

export const usageEventTypeValues = [
  'sandbox_launch',
  'preview_boot',
  'ssh_access',
  'web_terminal',
] as const

export type ReserveLeasePurpose = (typeof reserveLeasePurposeValues)[number]
export type UsageEventType = (typeof usageEventTypeValues)[number]

type BillingCtx = QueryCtx | MutationCtx

const DEFAULT_LOW_BALANCE_THRESHOLD_USD_CENTS = 300

const launchCostByPreset: Record<string, number> = {
  'general-engineer': 250,
  'frontend-builder': 275,
  'docs-writer': 200,
}

const fixedEventCostsUsdCents: Record<Exclude<UsageEventType, 'sandbox_launch'>, number> =
  {
    preview_boot: 35,
    ssh_access: 15,
    web_terminal: 15,
  }

function formatUsdCents(amountUsdCents: number) {
  return `$${(amountUsdCents / 100).toFixed(2)}`
}

export function getDefaultLowBalanceThresholdUsdCents() {
  return DEFAULT_LOW_BALANCE_THRESHOLD_USD_CENTS
}

export function getUsageEventCostUsdCents(
  agentPresetId: string,
  eventType: UsageEventType,
) {
  if (eventType === 'sandbox_launch') {
    return launchCostByPreset[agentPresetId] ?? launchCostByPreset['general-engineer']
  }

  return fixedEventCostsUsdCents[eventType]
}

export async function getBillingAccount(
  ctx: BillingCtx,
  userId: Id<'users'>,
): Promise<Doc<'billingAccounts'> | null> {
  return await ctx.db
    .query('billingAccounts')
    .withIndex('by_user_and_currency', (q) =>
      q.eq('userId', userId).eq('currency', BILLING_CURRENCY),
    )
    .unique()
}

export async function getOrCreateBillingAccount(
  ctx: MutationCtx,
  userId: Id<'users'>,
): Promise<Doc<'billingAccounts'>> {
  const existing = await getBillingAccount(ctx, userId)

  if (existing) {
    return existing
  }

  const now = Date.now()
  const accountId = await ctx.db.insert('billingAccounts', {
    userId,
    currency: BILLING_CURRENCY,
    fundingAsset: BILLING_ASSET,
    fundingNetwork: BILLING_NETWORK,
    fundedUsdCents: 0,
    unallocatedUsdCents: 0,
    createdAt: now,
    updatedAt: now,
  })
  const created = await ctx.db.get(accountId)

  if (!created) {
    throw new ConvexError('Failed to create the billing account.')
  }

  return created
}

export async function getAgentReserve(
  ctx: BillingCtx,
  userId: Id<'users'>,
  agentPresetId: string,
): Promise<Doc<'agentReserves'> | null> {
  return await ctx.db
    .query('agentReserves')
    .withIndex('by_user_and_agent_preset_id', (q) =>
      q.eq('userId', userId).eq('agentPresetId', agentPresetId),
    )
    .unique()
}

export async function getOrCreateAgentReserve(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    accountId: Id<'billingAccounts'>
    agentPresetId: string
    lowBalanceThresholdUsdCents?: number
  },
): Promise<Doc<'agentReserves'>> {
  const existing = await getAgentReserve(ctx, args.userId, args.agentPresetId)

  if (existing) {
    return existing
  }

  const now = Date.now()
  const reserveId = await ctx.db.insert('agentReserves', {
    userId: args.userId,
    accountId: args.accountId,
    agentPresetId: args.agentPresetId,
    currency: BILLING_CURRENCY,
    environment: BILLING_ENVIRONMENT,
    allocatedUsdCents: 0,
    availableUsdCents: 0,
    heldUsdCents: 0,
    spentUsdCentsLifetime: 0,
    lowBalanceThresholdUsdCents:
      args.lowBalanceThresholdUsdCents ?? DEFAULT_LOW_BALANCE_THRESHOLD_USD_CENTS,
    status: 'active',
    version: 0,
    createdAt: now,
    updatedAt: now,
  })
  const created = await ctx.db.get(reserveId)

  if (!created) {
    throw new ConvexError('Failed to create the agent reserve.')
  }

  return created
}

async function insertLedgerEntry(
  ctx: MutationCtx,
  entry: {
    userId: Id<'users'>
    accountId: Id<'billingAccounts'>
    agentReserveId?: Id<'agentReserves'>
    sandboxId?: Id<'sandboxes'>
    leaseId?: Id<'reserveLeases'>
    usageEventId?: Id<'usageEvents'>
    referenceType: 'funding' | 'allocation' | 'lease_hold' | 'lease_release' | 'usage_debit'
    direction: 'debit' | 'credit'
    bucket:
      | 'funding_unallocated'
      | 'reserve_available'
      | 'reserve_held'
      | 'revenue'
    amountUsdCents: number
    description: string
    createdAt?: number
  },
) {
  await ctx.db.insert('ledgerEntries', {
    userId: entry.userId,
    accountId: entry.accountId,
    ...(entry.agentReserveId ? { agentReserveId: entry.agentReserveId } : {}),
    ...(entry.sandboxId ? { sandboxId: entry.sandboxId } : {}),
    ...(entry.leaseId ? { leaseId: entry.leaseId } : {}),
    ...(entry.usageEventId ? { usageEventId: entry.usageEventId } : {}),
    referenceType: entry.referenceType,
    direction: entry.direction,
    bucket: entry.bucket,
    amountUsdCents: entry.amountUsdCents,
    description: entry.description,
    createdAt: entry.createdAt ?? Date.now(),
  })
}

function requirePositiveAmount(amountUsdCents: number, label: string) {
  if (!Number.isInteger(amountUsdCents) || amountUsdCents <= 0) {
    throw new ConvexError(`${label} must be a whole number of cents greater than zero.`)
  }
}

function requireActiveReserve(reserve: Doc<'agentReserves'>) {
  if (reserve.status !== 'active') {
    throw new ConvexError('This agent reserve is not active.')
  }
}

function buildReserveExhaustedMessage(agentPresetId: string, requiredUsdCents: number) {
  return `The ${agentPresetId} reserve needs at least ${formatUsdCents(requiredUsdCents)} available before it can continue. Top up funding first, then refill this agent reserve.`
}

async function patchSandboxSpend(
  ctx: MutationCtx,
  sandboxId: Id<'sandboxes'> | undefined,
  additionalUsdCents: number,
  now: number,
) {
  if (!sandboxId || additionalUsdCents <= 0) {
    return
  }

  const sandbox = await ctx.db.get(sandboxId)

  if (!sandbox) {
    return
  }

  await ctx.db.patch(sandboxId, {
    billedUsdCents: (sandbox.billedUsdCents ?? 0) + additionalUsdCents,
    lastBilledAt: now,
    updatedAt: now,
  })
}

export async function creditFundingTopup(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    amountUsdCents: number
    paymentReference: string
    idempotencyKey: string
    source: 'manual_testnet' | 'x402_settled'
    grossTokenAmount?: string
    metadataJson?: string
  },
) {
  requirePositiveAmount(args.amountUsdCents, 'Funding amount')

  const existingTransaction = await ctx.db
    .query('fundingTransactions')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingTransaction) {
    const existingAccount = await ctx.db.get(existingTransaction.accountId)

    if (!existingAccount) {
      throw new ConvexError('Funding transaction exists but its account is missing.')
    }

    return existingAccount
  }

  const account = await getOrCreateBillingAccount(ctx, args.userId)
  const now = Date.now()

  await ctx.db.patch(account._id, {
    fundedUsdCents: account.fundedUsdCents + args.amountUsdCents,
    unallocatedUsdCents: account.unallocatedUsdCents + args.amountUsdCents,
    updatedAt: now,
  })

  await ctx.db.insert('fundingTransactions', {
    userId: args.userId,
    accountId: account._id,
    source: args.source,
    status: 'settled',
    paymentReference: args.paymentReference,
    idempotencyKey: args.idempotencyKey,
    network: BILLING_NETWORK,
    asset: BILLING_ASSET,
    grossUsdCents: args.amountUsdCents,
    ...(args.grossTokenAmount ? { grossTokenAmount: args.grossTokenAmount } : {}),
    ...(args.metadataJson ? { metadataJson: args.metadataJson } : {}),
    createdAt: now,
    settledAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    referenceType: 'funding',
    direction: 'credit',
    bucket: 'funding_unallocated',
    amountUsdCents: args.amountUsdCents,
    description: `Funding top-up ${args.paymentReference}`,
    createdAt: now,
  })

  const updatedAccount = await ctx.db.get(account._id)

  if (!updatedAccount) {
    throw new ConvexError('Funding top-up was saved but the account could not be reloaded.')
  }

  return updatedAccount
}

export async function allocateFundingToReserve(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    agentPresetId: string
    amountUsdCents: number
    lowBalanceThresholdUsdCents?: number
  },
) {
  requirePositiveAmount(args.amountUsdCents, 'Allocation amount')

  const account = await getOrCreateBillingAccount(ctx, args.userId)

  if (account.unallocatedUsdCents < args.amountUsdCents) {
    throw new ConvexError(
      `Your unallocated funding balance is only ${formatUsdCents(account.unallocatedUsdCents)}.`,
    )
  }

  const reserve = await getOrCreateAgentReserve(ctx, {
    userId: args.userId,
    accountId: account._id,
    agentPresetId: args.agentPresetId,
    lowBalanceThresholdUsdCents: args.lowBalanceThresholdUsdCents,
  })
  const now = Date.now()

  await ctx.db.patch(account._id, {
    unallocatedUsdCents: account.unallocatedUsdCents - args.amountUsdCents,
    updatedAt: now,
  })
  await ctx.db.patch(reserve._id, {
    allocatedUsdCents: reserve.allocatedUsdCents + args.amountUsdCents,
    availableUsdCents: reserve.availableUsdCents + args.amountUsdCents,
    ...(args.lowBalanceThresholdUsdCents
      ? { lowBalanceThresholdUsdCents: args.lowBalanceThresholdUsdCents }
      : {}),
    version: reserve.version + 1,
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    agentReserveId: reserve._id,
    referenceType: 'allocation',
    direction: 'debit',
    bucket: 'funding_unallocated',
    amountUsdCents: args.amountUsdCents,
    description: `Allocate funding to ${args.agentPresetId}`,
    createdAt: now,
  })
  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    agentReserveId: reserve._id,
    referenceType: 'allocation',
    direction: 'credit',
    bucket: 'reserve_available',
    amountUsdCents: args.amountUsdCents,
    description: `Allocate funding to ${args.agentPresetId}`,
    createdAt: now,
  })

  const updatedReserve = await ctx.db.get(reserve._id)

  if (!updatedReserve) {
    throw new ConvexError('Agent reserve could not be reloaded after allocation.')
  }

  return updatedReserve
}

export async function createReserveLease(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    agentPresetId: string
    amountUsdCents: number
    purpose: ReserveLeasePurpose
    idempotencyKey: string
    workerKey: string
    sandboxId?: Id<'sandboxes'>
    expiresInSeconds?: number
    metadataJson?: string
  },
) {
  requirePositiveAmount(args.amountUsdCents, 'Lease amount')

  const existingLease = await ctx.db
    .query('reserveLeases')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingLease) {
    return existingLease
  }

  const account = await getOrCreateBillingAccount(ctx, args.userId)
  const reserve = await getAgentReserve(ctx, args.userId, args.agentPresetId)

  if (!reserve) {
    throw new ConvexError(buildReserveExhaustedMessage(args.agentPresetId, args.amountUsdCents))
  }

  requireActiveReserve(reserve)

  if (reserve.availableUsdCents < args.amountUsdCents) {
    throw new ConvexError(buildReserveExhaustedMessage(args.agentPresetId, args.amountUsdCents))
  }

  const now = Date.now()
  const expiresAt = now + (args.expiresInSeconds ?? 15 * 60) * 1000
  const leaseId = await ctx.db.insert('reserveLeases', {
    userId: args.userId,
    accountId: account._id,
    agentReserveId: reserve._id,
    ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
    workerKey: args.workerKey,
    purpose: args.purpose,
    amountUsdCents: args.amountUsdCents,
    status: 'active',
    expiresAt,
    idempotencyKey: args.idempotencyKey,
    ...(args.metadataJson ? { metadataJson: args.metadataJson } : {}),
    createdAt: now,
    updatedAt: now,
  })

  await ctx.db.patch(reserve._id, {
    availableUsdCents: reserve.availableUsdCents - args.amountUsdCents,
    heldUsdCents: reserve.heldUsdCents + args.amountUsdCents,
    version: reserve.version + 1,
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    agentReserveId: reserve._id,
    sandboxId: args.sandboxId,
    leaseId,
    referenceType: 'lease_hold',
    direction: 'debit',
    bucket: 'reserve_available',
    amountUsdCents: args.amountUsdCents,
    description: `Lease hold for ${args.purpose}`,
    createdAt: now,
  })
  await insertLedgerEntry(ctx, {
    userId: args.userId,
    accountId: account._id,
    agentReserveId: reserve._id,
    sandboxId: args.sandboxId,
    leaseId,
    referenceType: 'lease_hold',
    direction: 'credit',
    bucket: 'reserve_held',
    amountUsdCents: args.amountUsdCents,
    description: `Lease hold for ${args.purpose}`,
    createdAt: now,
  })

  const createdLease = await ctx.db.get(leaseId)

  if (!createdLease) {
    throw new ConvexError('Reserve lease could not be loaded after creation.')
  }

  return createdLease
}

export async function releaseReserveLease(
  ctx: MutationCtx,
  args: {
    leaseId: Id<'reserveLeases'>
    reason: string
  },
) {
  const lease = await ctx.db.get(args.leaseId)

  if (!lease) {
    throw new ConvexError('Reserve lease not found.')
  }

  if (lease.status !== 'active') {
    return lease
  }

  const reserve = await ctx.db.get(lease.agentReserveId)

  if (!reserve) {
    throw new ConvexError('Agent reserve not found for this lease.')
  }

  const now = Date.now()
  await ctx.db.patch(reserve._id, {
    availableUsdCents: reserve.availableUsdCents + lease.amountUsdCents,
    heldUsdCents: reserve.heldUsdCents - lease.amountUsdCents,
    version: reserve.version + 1,
    updatedAt: now,
  })
  await ctx.db.patch(lease._id, {
    status: 'released',
    updatedAt: now,
  })

  await insertLedgerEntry(ctx, {
    userId: lease.userId,
    accountId: lease.accountId,
    agentReserveId: lease.agentReserveId,
    sandboxId: lease.sandboxId,
    leaseId: lease._id,
    referenceType: 'lease_release',
    direction: 'debit',
    bucket: 'reserve_held',
    amountUsdCents: lease.amountUsdCents,
    description: args.reason,
    createdAt: now,
  })
  await insertLedgerEntry(ctx, {
    userId: lease.userId,
    accountId: lease.accountId,
    agentReserveId: lease.agentReserveId,
    sandboxId: lease.sandboxId,
    leaseId: lease._id,
    referenceType: 'lease_release',
    direction: 'credit',
    bucket: 'reserve_available',
    amountUsdCents: lease.amountUsdCents,
    description: args.reason,
    createdAt: now,
  })

  const releasedLease = await ctx.db.get(lease._id)

  if (!releasedLease) {
    throw new ConvexError('Reserve lease could not be reloaded after release.')
  }

  return releasedLease
}

export async function captureReserveLeaseUsage(
  ctx: MutationCtx,
  args: {
    leaseId: Id<'reserveLeases'>
    eventType: UsageEventType
    description: string
    quantitySummary?: string
    sandboxId?: Id<'sandboxes'>
    idempotencyKey: string
    costUsdCents?: number
  },
) {
  const existingUsage = await ctx.db
    .query('usageEvents')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', args.idempotencyKey))
    .unique()

  if (existingUsage) {
    return existingUsage
  }

  const lease = await ctx.db.get(args.leaseId)

  if (!lease) {
    throw new ConvexError('Reserve lease not found.')
  }

  if (lease.status !== 'active') {
    throw new ConvexError('This reserve lease is no longer active.')
  }

  const reserve = await ctx.db.get(lease.agentReserveId)

  if (!reserve) {
    throw new ConvexError('Agent reserve not found for this lease.')
  }

  const costUsdCents = args.costUsdCents ?? lease.amountUsdCents

  if (costUsdCents > lease.amountUsdCents) {
    throw new ConvexError('Lease capture exceeds the held amount.')
  }

  const releasedUsdCents = lease.amountUsdCents - costUsdCents
  const now = Date.now()
  const usageEventId = await ctx.db.insert('usageEvents', {
    userId: lease.userId,
    accountId: lease.accountId,
    agentReserveId: lease.agentReserveId,
    ...(args.sandboxId ?? lease.sandboxId ? { sandboxId: args.sandboxId ?? lease.sandboxId } : {}),
    leaseId: lease._id,
    eventType: args.eventType,
    ...(args.quantitySummary ? { quantitySummary: args.quantitySummary } : {}),
    description: args.description,
    costUsdCents,
    unitPriceVersion: BILLING_PRICE_VERSION,
    idempotencyKey: args.idempotencyKey,
    createdAt: now,
  })

  await ctx.db.patch(reserve._id, {
    heldUsdCents: reserve.heldUsdCents - lease.amountUsdCents,
    availableUsdCents: reserve.availableUsdCents + releasedUsdCents,
    spentUsdCentsLifetime: reserve.spentUsdCentsLifetime + costUsdCents,
    version: reserve.version + 1,
    updatedAt: now,
  })
  await ctx.db.patch(lease._id, {
    status: 'captured',
    updatedAt: now,
  })
  await patchSandboxSpend(
    ctx,
    args.sandboxId ?? lease.sandboxId,
    costUsdCents,
    now,
  )

  await insertLedgerEntry(ctx, {
    userId: lease.userId,
    accountId: lease.accountId,
    agentReserveId: lease.agentReserveId,
    sandboxId: args.sandboxId ?? lease.sandboxId,
    leaseId: lease._id,
    usageEventId,
    referenceType: 'usage_debit',
    direction: 'debit',
    bucket: 'reserve_held',
    amountUsdCents: lease.amountUsdCents,
    description: args.description,
    createdAt: now,
  })

  if (releasedUsdCents > 0) {
    await insertLedgerEntry(ctx, {
      userId: lease.userId,
      accountId: lease.accountId,
      agentReserveId: lease.agentReserveId,
      sandboxId: args.sandboxId ?? lease.sandboxId,
      leaseId: lease._id,
      usageEventId,
      referenceType: 'lease_release',
      direction: 'credit',
      bucket: 'reserve_available',
      amountUsdCents: releasedUsdCents,
      description: `Unused hold released for ${args.eventType}`,
      createdAt: now,
    })
  }

  await insertLedgerEntry(ctx, {
    userId: lease.userId,
    accountId: lease.accountId,
    agentReserveId: lease.agentReserveId,
    sandboxId: args.sandboxId ?? lease.sandboxId,
    leaseId: lease._id,
    usageEventId,
    referenceType: 'usage_debit',
    direction: 'credit',
    bucket: 'revenue',
    amountUsdCents: costUsdCents,
    description: args.description,
    createdAt: now,
  })

  const usage = await ctx.db.get(usageEventId)

  if (!usage) {
    throw new ConvexError('Usage event could not be loaded after capture.')
  }

  return usage
}
