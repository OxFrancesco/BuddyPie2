import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { getCurrentUserRecord, requireCurrentUserRecord } from './lib/auth'
import {
  captureReserveLeaseUsage,
  createReserveLease,
  getUsageEventCostUsdCents,
  releaseReserveLease,
} from './lib/billing'

export const sandboxRecordValidator = v.object({
  _id: v.id('sandboxes'),
  _creationTime: v.number(),
  userId: v.id('users'),
  repoUrl: v.string(),
  repoName: v.string(),
  repoBranch: v.optional(v.string()),
  repoProvider: v.union(v.literal('github'), v.literal('git')),
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
  errorMessage: v.optional(v.string()),
  agentReserveId: v.optional(v.id('agentReserves')),
  launchLeaseId: v.optional(v.id('reserveLeases')),
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
    repoUrl: v.string(),
    repoName: v.string(),
    repoBranch: v.optional(v.string()),
    repoProvider: v.union(v.literal('github'), v.literal('git')),
    agentPresetId: v.string(),
    agentLabel: v.string(),
    agentProvider: v.string(),
    agentModel: v.string(),
    initialPrompt: v.optional(v.string()),
  },
  returns: sandboxRecordValidator,
  handler: async (ctx, args) => {
    const user = await requireCurrentUserRecord(ctx)
    const now = Date.now()
    const sandboxId = await ctx.db.insert('sandboxes', {
      userId: user._id,
      repoUrl: args.repoUrl,
      repoName: args.repoName,
      repoProvider: args.repoProvider,
      agentPresetId: args.agentPresetId,
      agentLabel: args.agentLabel,
      agentProvider: args.agentProvider,
      agentModel: args.agentModel,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
      ...(args.repoBranch ? { repoBranch: args.repoBranch } : {}),
      ...(args.initialPrompt ? { initialPrompt: args.initialPrompt } : {}),
      billedUsdCents: 0,
    })
    const launchLease = await createReserveLease(ctx, {
      userId: user._id,
      agentPresetId: args.agentPresetId,
      amountUsdCents: getUsageEventCostUsdCents(
        args.agentPresetId,
        'sandbox_launch',
      ),
      purpose: 'sandbox_launch',
      idempotencyKey: `sandbox-launch:${sandboxId}`,
      workerKey: 'buddypie:sandbox-launch',
      sandboxId,
    })

    await ctx.db.patch(sandboxId, {
      agentReserveId: launchLease.agentReserveId,
      launchLeaseId: launchLease._id,
      updatedAt: now,
    })

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
    opencodeSessionId: v.optional(v.string()),
  },
  returns: sandboxRecordValidator,
  handler: async (ctx, args) => {
    const sandbox = await getOwnedSandbox(ctx, args.sandboxId)

    if (sandbox.launchLeaseId) {
      await captureReserveLeaseUsage(ctx, {
        leaseId: sandbox.launchLeaseId,
        sandboxId: sandbox._id,
        eventType: 'sandbox_launch',
        description: `OpenCode sandbox launch for ${sandbox.repoName}`,
        quantitySummary: sandbox.repoBranch ?? 'default branch',
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

    if (sandbox.launchLeaseId) {
      await releaseReserveLease(ctx, {
        leaseId: sandbox.launchLeaseId,
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
    await getOwnedSandbox(ctx, args.sandboxId)
    await ctx.db.delete(args.sandboxId)
    return null
  },
})
