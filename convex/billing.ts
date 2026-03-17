import { ConvexError, v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server'
import { requireCurrentUserRecord } from './lib/auth'
import {
  BILLING_ASSET,
  BILLING_CURRENCY,
  BILLING_NETWORK,
  captureReserveLeaseUsage,
  creditFundingTopup,
  getBillingAccount,
  getDefaultLowBalanceThresholdUsdCents,
  getUsageEventCostUsdCents,
  releaseReserveLease,
  createReserveLease,
  allocateFundingToReserve,
} from './lib/billing'

const reserveStatusValidator = v.union(
  v.literal('active'),
  v.literal('paused'),
  v.literal('closed'),
)

const leaseStatusValidator = v.union(
  v.literal('active'),
  v.literal('captured'),
  v.literal('released'),
  v.literal('expired'),
)

const usageEventTypeValidator = v.union(
  v.literal('sandbox_launch'),
  v.literal('preview_boot'),
  v.literal('ssh_access'),
  v.literal('web_terminal'),
)

const runtimeUsageEventTypeValidator = v.union(
  v.literal('preview_boot'),
  v.literal('ssh_access'),
  v.literal('web_terminal'),
)

const reserveLeasePurposeValidator = v.union(
  v.literal('sandbox_launch'),
  v.literal('preview_boot'),
  v.literal('ssh_access'),
  v.literal('web_terminal'),
  v.literal('generic'),
)

export const billingAccountValidator = v.object({
  _id: v.id('billingAccounts'),
  _creationTime: v.number(),
  userId: v.id('users'),
  currency: v.literal('USD'),
  fundingAsset: v.literal('USDC'),
  fundingNetwork: v.literal('base-sepolia'),
  fundedUsdCents: v.number(),
  unallocatedUsdCents: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})

export const agentReserveValidator = v.object({
  _id: v.id('agentReserves'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.id('billingAccounts'),
  agentPresetId: v.string(),
  currency: v.literal('USD'),
  environment: v.literal('prod'),
  allocatedUsdCents: v.number(),
  availableUsdCents: v.number(),
  heldUsdCents: v.number(),
  spentUsdCentsLifetime: v.number(),
  lowBalanceThresholdUsdCents: v.number(),
  status: reserveStatusValidator,
  version: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})

export const reserveLeaseValidator = v.object({
  _id: v.id('reserveLeases'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.id('billingAccounts'),
  agentReserveId: v.id('agentReserves'),
  sandboxId: v.optional(v.id('sandboxes')),
  workerKey: v.string(),
  purpose: reserveLeasePurposeValidator,
  amountUsdCents: v.number(),
  status: leaseStatusValidator,
  expiresAt: v.number(),
  idempotencyKey: v.string(),
  metadataJson: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})

export const usageEventValidator = v.object({
  _id: v.id('usageEvents'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.id('billingAccounts'),
  agentReserveId: v.id('agentReserves'),
  sandboxId: v.optional(v.id('sandboxes')),
  leaseId: v.optional(v.id('reserveLeases')),
  eventType: usageEventTypeValidator,
  quantitySummary: v.optional(v.string()),
  description: v.string(),
  costUsdCents: v.number(),
  unitPriceVersion: v.string(),
  idempotencyKey: v.string(),
  createdAt: v.number(),
})

const ledgerEntryValidator = v.object({
  _id: v.id('ledgerEntries'),
  _creationTime: v.number(),
  userId: v.id('users'),
  accountId: v.id('billingAccounts'),
  agentReserveId: v.optional(v.id('agentReserves')),
  sandboxId: v.optional(v.id('sandboxes')),
  leaseId: v.optional(v.id('reserveLeases')),
  usageEventId: v.optional(v.id('usageEvents')),
  referenceType: v.union(
    v.literal('funding'),
    v.literal('allocation'),
    v.literal('lease_hold'),
    v.literal('lease_release'),
    v.literal('usage_debit'),
  ),
  direction: v.union(v.literal('debit'), v.literal('credit')),
  bucket: v.union(
    v.literal('funding_unallocated'),
    v.literal('reserve_available'),
    v.literal('reserve_held'),
    v.literal('revenue'),
  ),
  amountUsdCents: v.number(),
  description: v.string(),
  createdAt: v.number(),
})

export const dashboardSummary = query({
  args: {},
  returns: v.object({
    account: v.object({
      accountId: v.optional(v.id('billingAccounts')),
      currency: v.literal('USD'),
      fundingAsset: v.literal('USDC'),
      fundingNetwork: v.literal('base-sepolia'),
      fundedUsdCents: v.number(),
      unallocatedUsdCents: v.number(),
    }),
    reserves: v.array(agentReserveValidator),
    recentLedger: v.array(ledgerEntryValidator),
  }),
  handler: async (ctx) => {
    const user = await requireCurrentUserRecord(ctx)
    const account = await getBillingAccount(ctx, user._id)
    const reserves = await ctx.db
      .query('agentReserves')
      .withIndex('by_user_and_agent_preset_id', (q) => q.eq('userId', user._id))
      .take(20)
    const recentLedger = account
      ? await ctx.db
          .query('ledgerEntries')
          .withIndex('by_account_and_created_at', (q) => q.eq('accountId', account._id))
          .order('desc')
          .take(20)
      : []

    return {
      account: {
        ...(account ? { accountId: account._id } : {}),
        currency: BILLING_CURRENCY,
        fundingAsset: BILLING_ASSET,
        fundingNetwork: BILLING_NETWORK,
        fundedUsdCents: account?.fundedUsdCents ?? 0,
        unallocatedUsdCents: account?.unallocatedUsdCents ?? 0,
      },
      reserves,
      recentLedger,
    }
  },
})

export const sandboxUsage = query({
  args: {
    sandboxId: v.id('sandboxes'),
  },
  returns: v.object({
    billedUsdCents: v.number(),
    reserve: v.union(agentReserveValidator, v.null()),
    usageEvents: v.array(usageEventValidator),
  }),
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const sandbox = await ctx.db.get(args.sandboxId)

    if (!sandbox || sandbox.userId !== user._id) {
      return {
        billedUsdCents: 0,
        reserve: null,
        usageEvents: [],
      }
    }

    const reserve = sandbox.agentReserveId
      ? await ctx.db.get(sandbox.agentReserveId)
      : null
    const usageEvents = await ctx.db
      .query('usageEvents')
      .withIndex('by_sandbox_and_created_at', (q) => q.eq('sandboxId', args.sandboxId))
      .order('desc')
      .take(20)

    return {
      billedUsdCents: sandbox.billedUsdCents ?? 0,
      reserve,
      usageEvents,
    }
  },
})

export const recordFundingTopup = internalMutation({
  args: {
    amountUsdCents: v.number(),
    paymentReference: v.string(),
    idempotencyKey: v.string(),
    source: v.union(v.literal('manual_testnet'), v.literal('x402_settled')),
    grossTokenAmount: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
  },
  returns: billingAccountValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await creditFundingTopup(ctx, {
      userId: user._id,
      amountUsdCents: args.amountUsdCents,
      paymentReference: args.paymentReference,
      idempotencyKey: args.idempotencyKey,
      source: args.source,
      grossTokenAmount: args.grossTokenAmount,
      metadataJson: args.metadataJson,
    })
  },
})

export const allocateReserve = mutation({
  args: {
    agentPresetId: v.string(),
    amountUsdCents: v.number(),
    lowBalanceThresholdUsdCents: v.optional(v.number()),
  },
  returns: agentReserveValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)

    return await allocateFundingToReserve(ctx, {
      userId: user._id,
      agentPresetId: args.agentPresetId,
      amountUsdCents: args.amountUsdCents,
      lowBalanceThresholdUsdCents:
        args.lowBalanceThresholdUsdCents ?? getDefaultLowBalanceThresholdUsdCents(),
    })
  },
})

export const createSandboxEventLease = internalMutation({
  args: {
    sandboxId: v.id('sandboxes'),
    eventType: runtimeUsageEventTypeValidator,
    idempotencyKey: v.string(),
    quantitySummary: v.optional(v.string()),
  },
  returns: reserveLeaseValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const sandbox = await ctx.db.get(args.sandboxId)

    if (!sandbox || sandbox.userId !== user._id) {
      throw new ConvexError('Sandbox not found.')
    }

    const agentPresetId = sandbox.agentPresetId ?? 'general-engineer'
    const amountUsdCents = getUsageEventCostUsdCents(agentPresetId, args.eventType)

    return await createReserveLease(ctx, {
      userId: user._id,
      agentPresetId,
      amountUsdCents,
      purpose: args.eventType,
      idempotencyKey: args.idempotencyKey,
      workerKey: `buddypie:${args.eventType}`,
      sandboxId: sandbox._id,
      metadataJson: args.quantitySummary,
    })
  },
})

export const captureSandboxEventLease = internalMutation({
  args: {
    leaseId: v.id('reserveLeases'),
    sandboxId: v.id('sandboxes'),
    eventType: runtimeUsageEventTypeValidator,
    idempotencyKey: v.string(),
    description: v.string(),
    quantitySummary: v.optional(v.string()),
  },
  returns: usageEventValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const lease = await ctx.db.get(args.leaseId)
    const sandbox = await ctx.db.get(args.sandboxId)

    if (!lease || lease.userId !== user._id) {
      throw new ConvexError('Reserve lease not found.')
    }

    if (!sandbox || sandbox.userId !== user._id) {
      throw new ConvexError('Sandbox not found.')
    }

    if (lease.sandboxId !== sandbox._id) {
      throw new ConvexError('Reserve lease does not belong to this sandbox.')
    }

    if (lease.purpose !== args.eventType) {
      throw new ConvexError('Reserve lease purpose does not match the event type.')
    }

    if (sandbox.agentReserveId && lease.agentReserveId !== sandbox.agentReserveId) {
      throw new ConvexError('Reserve lease does not match the sandbox reserve.')
    }

    return await captureReserveLeaseUsage(ctx, {
      leaseId: lease._id,
      sandboxId: sandbox._id,
      eventType: args.eventType,
      description: args.description,
      quantitySummary: args.quantitySummary,
      idempotencyKey: args.idempotencyKey,
    })
  },
})

export const releaseLease = internalMutation({
  args: {
    leaseId: v.id('reserveLeases'),
    reason: v.string(),
  },
  returns: reserveLeaseValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const lease = await ctx.db.get(args.leaseId)

    if (!lease || lease.userId !== user._id) {
      throw new ConvexError('Reserve lease not found.')
    }

    return await releaseReserveLease(ctx, args)
  },
})

export const expireActiveLeases = internalMutation({
  args: {},
  returns: v.object({
    expiredLeaseCount: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now()
    const expiredLeases = await ctx.db
      .query('reserveLeases')
      .withIndex('by_status_and_expires_at', (q) =>
        q.eq('status', 'active').lt('expiresAt', now),
      )
      .take(50)

    for (const lease of expiredLeases) {
      await releaseReserveLease(ctx, {
        leaseId: lease._id,
        reason: `Lease expired at ${new Date(lease.expiresAt).toISOString()}`,
      })
    }

    return {
      expiredLeaseCount: expiredLeases.length,
    }
  },
})
