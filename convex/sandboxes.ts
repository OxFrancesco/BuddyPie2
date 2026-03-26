import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { getCurrentUserRecord, requireCurrentUserRecord } from './lib/auth'
import {
  captureCreditHold as captureCreditHoldInWallet,
  getUsageEventCostUsdCents,
  holdCredits as holdCreditsInWallet,
  releaseCreditHold as releaseCreditHoldInWallet,
} from './lib/billing'

export const sandboxRecordValidator = v.object({
  _id: v.id('sandboxes'),
  _creationTime: v.number(),
  userId: v.id('users'),
  repoUrl: v.optional(v.string()),
  repoName: v.string(),
  repoBranch: v.optional(v.string()),
  repoProvider: v.optional(v.union(v.literal('github'), v.literal('git'))),
  agentPresetId: v.optional(v.string()),
  agentLabel: v.optional(v.string()),
  agentProvider: v.optional(v.string()),
  agentModel: v.optional(v.string()),
  initialPrompt: v.optional(v.string()),
  status: v.union(
    v.literal('creating'),
    v.literal('ready'),
    v.literal('failed'),
  ),
  daytonaSandboxId: v.optional(v.string()),
  opencodeSessionId: v.optional(v.string()),
  previewUrl: v.optional(v.string()),
  previewUrlPattern: v.optional(v.string()),
  workspacePath: v.optional(v.string()),
  previewAppPath: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  agentReserveId: v.optional(v.id('agentReserves')),
  launchLeaseId: v.optional(v.id('reserveLeases')),
  billingAccountId: v.optional(v.id('creditAccounts')),
  launchHoldId: v.optional(v.id('creditHolds')),
  pendingPaymentMethod: v.optional(
    v.union(
      v.literal('credits'),
      v.literal('x402'),
      v.literal('delegated_budget'),
    ),
  ),
  lastChargeId: v.optional(v.id('billingCharges')),
  billedUsdCents: v.optional(v.number()),
  lastBilledAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})

async function getOwnedSandbox(
  ctx: MutationCtx,
  sandboxId: Id<'sandboxes'>,
): Promise<Doc<'sandboxes'>> {
  const user = await requireCurrentUserRecord(ctx)
  const sandbox = await ctx.db.get(sandboxId)

  if (!sandbox || sandbox.userId !== user._id) {
    throw new ConvexError('Sandbox not found.')
  }

  return sandbox
}

export const list = query({
  args: {},
  returns: v.array(sandboxRecordValidator),
  handler: async (ctx) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return []
    }

    return await ctx.db
      .query('sandboxes')
      .withIndex('by_user_and_created_at', (q) => q.eq('userId', user._id))
      .order('desc')
      .take(25)
  },
})

export const get = query({
  args: {
    sandboxId: v.id('sandboxes'),
  },
  returns: v.union(sandboxRecordValidator, v.null()),
  handler: async (ctx, args) => {
    const user = await getCurrentUserRecord(ctx)

    if (!user) {
      return null
    }

    const sandbox = await ctx.db.get(args.sandboxId)

    if (!sandbox || sandbox.userId !== user._id) {
      return null
    }

    return sandbox
  },
})

export const createPending = mutation({
  args: {
    repoUrl: v.optional(v.string()),
    repoName: v.string(),
    repoBranch: v.optional(v.string()),
    repoProvider: v.optional(v.union(v.literal('github'), v.literal('git'))),
    agentPresetId: v.string(),
    agentLabel: v.string(),
    agentProvider: v.string(),
    agentModel: v.string(),
    initialPrompt: v.optional(v.string()),
    paymentMethod: v.union(
      v.literal('credits'),
      v.literal('x402'),
      v.literal('delegated_budget'),
    ),
  },
  returns: sandboxRecordValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const now = Date.now()
    const sandboxId = await ctx.db.insert('sandboxes', {
      userId: user._id,
      repoName: args.repoName,
      agentPresetId: args.agentPresetId,
      agentLabel: args.agentLabel,
      agentProvider: args.agentProvider,
      agentModel: args.agentModel,
      status: 'creating',
      pendingPaymentMethod: args.paymentMethod,
      createdAt: now,
      updatedAt: now,
      ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
      ...(args.repoProvider ? { repoProvider: args.repoProvider } : {}),
      ...(args.repoBranch ? { repoBranch: args.repoBranch } : {}),
      ...(args.initialPrompt ? { initialPrompt: args.initialPrompt } : {}),
      billedUsdCents: 0,
    })

    if (args.paymentMethod === 'credits') {
      const launchHold = await holdCreditsInWallet(ctx, {
        userId: user._id,
        sandboxId,
        agentPresetId: args.agentPresetId,
        amountUsdCents: getUsageEventCostUsdCents(
          args.agentPresetId,
          'sandbox_launch',
        ),
        purpose: 'sandbox_launch',
        idempotencyKey: `sandbox-launch:${sandboxId}`,
        description: `Launch hold for ${args.repoName}`,
        quantitySummary: args.repoUrl
          ? args.repoBranch ?? 'default branch'
          : 'no repository attached',
      })

      await ctx.db.patch(sandboxId, {
        billingAccountId: launchHold.accountId,
        launchHoldId: launchHold._id,
        updatedAt: now,
      })
    }

    const sandbox = await ctx.db.get(sandboxId)

    if (!sandbox) {
      throw new ConvexError('Failed to create a sandbox record.')
    }

    return sandbox
  },
})

export const markReady = mutation({
  args: {
    sandboxId: v.id('sandboxes'),
    daytonaSandboxId: v.string(),
    previewUrl: v.string(),
    previewUrlPattern: v.optional(v.string()),
    workspacePath: v.string(),
    previewAppPath: v.optional(v.string()),
    opencodeSessionId: v.optional(v.string()),
  },
  returns: sandboxRecordValidator,
  handler: async (ctx, args) => {
    const sandbox = await getOwnedSandbox(ctx, args.sandboxId)

    if (sandbox.launchHoldId) {
      await captureCreditHoldInWallet(ctx, {
        holdId: sandbox.launchHoldId,
        sandboxId: sandbox._id,
        eventType: 'sandbox_launch',
        description: `OpenCode sandbox launch for ${sandbox.repoName}`,
        quantitySummary: sandbox.repoUrl
          ? sandbox.repoBranch ?? 'default branch'
          : 'no repository attached',
        idempotencyKey: `sandbox-launch-capture:${sandbox._id}`,
        costUsdCents: getUsageEventCostUsdCents(
          sandbox.agentPresetId ?? 'general-engineer',
          'sandbox_launch',
        ),
      })
    }

    await ctx.db.patch(args.sandboxId, {
      status: 'ready',
      daytonaSandboxId: args.daytonaSandboxId,
      previewUrl: args.previewUrl,
      ...(args.previewUrlPattern ? { previewUrlPattern: args.previewUrlPattern } : {}),
      workspacePath: args.workspacePath,
      ...(args.previewAppPath ? { previewAppPath: args.previewAppPath } : {}),
      ...(args.opencodeSessionId ? { opencodeSessionId: args.opencodeSessionId } : {}),
      updatedAt: Date.now(),
    })

    const updatedSandbox = await ctx.db.get(args.sandboxId)

    if (!updatedSandbox) {
      throw new ConvexError('Sandbox not found after launch.')
    }

    return updatedSandbox
  },
})

export const markFailed = mutation({
  args: {
    sandboxId: v.id('sandboxes'),
    errorMessage: v.string(),
  },
  returns: sandboxRecordValidator,
  handler: async (ctx, args) => {
    const sandbox = await getOwnedSandbox(ctx, args.sandboxId)

    if (sandbox.launchHoldId) {
      await releaseCreditHoldInWallet(ctx, {
        holdId: sandbox.launchHoldId,
        reason: `Launch failed for ${sandbox.repoName}`,
      })
    }

    await ctx.db.patch(args.sandboxId, {
      status: 'failed',
      errorMessage: args.errorMessage,
      updatedAt: Date.now(),
    })

    const updatedSandbox = await ctx.db.get(args.sandboxId)

    if (!updatedSandbox) {
      throw new ConvexError('Sandbox not found after failure.')
    }

    return updatedSandbox
  },
})

export const remove = mutation({
  args: {
    sandboxId: v.id('sandboxes'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sandbox = await getOwnedSandbox(ctx, args.sandboxId)

    if (sandbox.launchHoldId) {
      try {
        await releaseCreditHoldInWallet(ctx, {
          holdId: sandbox.launchHoldId,
          reason: `Sandbox ${sandbox.repoName} was removed before the launch hold settled.`,
        })
      } catch {
        // Best effort cleanup for orphaned holds.
      }
    }

    await ctx.db.delete(args.sandboxId)
    return null
  },
})
