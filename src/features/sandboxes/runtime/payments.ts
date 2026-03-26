import { randomUUID } from 'node:crypto'
import { api } from 'convex/_generated/api'
import type { Doc, Id } from 'convex/_generated/dataModel'
import { Effect, Exit, Ref } from 'effect'
import {
  BillingService,
  ConvexService,
} from '~/lib/server/effect/services'
import {
  PaymentError,
  SandboxError,
} from '~/lib/server/effect/errors'
import {
  getBillingEventPriceUsdCents,
  type BillingPaymentMethod,
} from '../../../../convex/lib/billingConfig'

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function billingMutation<T>(options: {
  try: () => Promise<T>
  fallback: string
}) {
  return Effect.tryPromise({
    try: options.try,
    catch: (error) =>
      new PaymentError({
        message: normalizeUnknownMessage(error, options.fallback),
        cause: error,
      }),
  })
}

export function requireDelegatedBudgetAllowance(args: {
  requiredAmountUsdCents: number
  actionLabel: string
}) {
  return Effect.flatMap(BillingService, (billing) =>
    billing.requireDelegatedBudgetAllowance(args),
  )
}

export function withPaidSandboxAction<T, R>(args: {
  sandboxId: Id<'sandboxes'>
  agentPresetId: string
  eventType: 'preview_boot' | 'ssh_access' | 'web_terminal'
  paymentMethod: BillingPaymentMethod
  quantitySummary?: string
  description: string
  action: Effect.Effect<T, SandboxError, R>
  shouldCapture?: (result: T) => boolean
  releaseReason?: string
}) {
  return Effect.gen(function*() {
    const convex = yield* ConvexService
    const billing = yield* BillingService
    const amountUsdCents = getBillingEventPriceUsdCents(
      args.agentPresetId,
      args.eventType,
    )

    if (args.paymentMethod === 'x402') {
      return yield* args.action
    }

    if (args.paymentMethod === 'delegated_budget') {
      let delegatedBudget: Doc<'delegatedBudgets'> | null = null

      if (!args.shouldCapture) {
        delegatedBudget = yield* billing.requireDelegatedBudgetAllowance({
          requiredAmountUsdCents: amountUsdCents,
          actionLabel: args.description,
        })
      }

      const result = yield* args.action

      if (args.shouldCapture && !args.shouldCapture(result)) {
        return result
      }

      delegatedBudget ??= yield* billing.requireDelegatedBudgetAllowance({
        requiredAmountUsdCents: amountUsdCents,
        actionLabel: args.description,
      })

      const idempotencyKey = `${args.eventType}:${args.sandboxId}:${randomUUID()}`
      const settlement = yield* billing.settleDelegatedBudgetOnchain({
        budget: delegatedBudget,
        amountUsdCents,
        idempotencyKey,
      })

      yield* billingMutation({
        try: () =>
          convex.context.convex.mutation(api.billing.recordDelegatedBudgetCharge, {
            delegatedBudgetId: delegatedBudget._id,
            sandboxId: args.sandboxId,
            agentPresetId: args.agentPresetId,
            eventType: args.eventType,
            amountUsdCents,
            idempotencyKey,
            description: args.description,
            quantitySummary: args.quantitySummary,
            settlementId: settlement.settlementId,
            txHash: settlement.txHash,
            remainingAmountUsdCents: settlement.budget.remainingAmountUsdCents,
            ...(settlement.budget.periodStartedAt
              ? { periodStartedAt: settlement.budget.periodStartedAt }
              : {}),
            ...(settlement.budget.periodEndsAt
              ? { periodEndsAt: settlement.budget.periodEndsAt }
              : {}),
            ...(settlement.budget.lastSettlementAt
              ? { settledAt: settlement.budget.lastSettlementAt }
              : {}),
            metadataJson: JSON.stringify({
              contractBudgetId: delegatedBudget.contractBudgetId,
            }),
          }),
        fallback:
          'BuddyPie could not record the delegated-budget charge after settlement.',
      })

      return result
    }

    const holdStateRef = yield* Ref.make<'held' | 'released' | 'captured'>(
      'held',
    )
    const hold = yield* Effect.acquireRelease(
      billingMutation({
        try: () =>
          convex.context.convex.mutation(api.billing.holdCredits, {
            sandboxId: args.sandboxId,
            agentPresetId: args.agentPresetId,
            purpose: args.eventType,
            amountUsdCents,
            idempotencyKey: `${args.eventType}:${args.sandboxId}:${Date.now()}`,
            quantitySummary: args.quantitySummary,
            description: args.description,
          }),
        fallback: 'BuddyPie could not create the credit hold for this action.',
      }),
      (hold, exit) =>
        Effect.gen(function*() {
          const holdState = yield* Ref.get(holdStateRef)

          if (holdState !== 'held' || Exit.isSuccess(exit)) {
            return
          }

          yield* billingMutation({
            try: () =>
              convex.context.convex.mutation(api.billing.releaseCreditHold, {
                holdId: hold._id,
                reason:
                  args.releaseReason ?? `${args.eventType} failed before capture.`,
              }),
            fallback:
              'BuddyPie could not release the credit hold after the action failed.',
          }).pipe(Effect.catchAll(() => Effect.void))
        }),
    )

    const result = yield* args.action

    if (args.shouldCapture && !args.shouldCapture(result)) {
      yield* billingMutation({
        try: () =>
          convex.context.convex.mutation(api.billing.releaseCreditHold, {
            holdId: hold._id,
            reason:
              args.releaseReason ?? `No charge captured for ${args.eventType}.`,
          }),
        fallback: 'BuddyPie could not release the unused credit hold.',
      })
      yield* Ref.set(holdStateRef, 'released')

      return result
    }

    yield* billingMutation({
      try: () =>
        convex.context.convex.mutation(api.billing.captureCreditHold, {
          holdId: hold._id,
          sandboxId: args.sandboxId,
          eventType: args.eventType,
          idempotencyKey: `capture:${hold.idempotencyKey}`,
          description: args.description,
          quantitySummary: args.quantitySummary,
          costUsdCents: amountUsdCents,
        }),
      fallback: 'BuddyPie could not capture the credit hold for this action.',
    })
    yield* Ref.set(holdStateRef, 'captured')

    return result
  })
}

export function captureDelegatedLaunchCharge(args: {
  sandboxId: Id<'sandboxes'>
  agentPresetId: string
  repoName: string
  repoBranch?: string
}) {
  return Effect.gen(function*() {
    const convex = yield* ConvexService
    const billing = yield* BillingService
    const amountUsdCents = getBillingEventPriceUsdCents(
      args.agentPresetId,
      'sandbox_launch',
    )
    const delegatedBudget = yield* billing.requireDelegatedBudgetAllowance({
      requiredAmountUsdCents: amountUsdCents,
      actionLabel: `launching OpenCode for ${args.repoName}`,
    })
    const idempotencyKey = `sandbox_launch:${args.sandboxId}:${randomUUID()}`
    const settlement = yield* billing.settleDelegatedBudgetOnchain({
      budget: delegatedBudget,
      amountUsdCents,
      idempotencyKey,
    })

    yield* billingMutation({
      try: () =>
        convex.context.convex.mutation(api.billing.recordDelegatedBudgetCharge, {
          delegatedBudgetId: delegatedBudget._id,
          sandboxId: args.sandboxId,
          agentPresetId: args.agentPresetId,
          eventType: 'sandbox_launch',
          amountUsdCents,
          idempotencyKey,
          description: `OpenCode sandbox launch for ${args.repoName}`,
          quantitySummary: args.repoBranch ?? 'no repository attached',
          settlementId: settlement.settlementId,
          txHash: settlement.txHash,
          remainingAmountUsdCents: settlement.budget.remainingAmountUsdCents,
          ...(settlement.budget.periodStartedAt
            ? { periodStartedAt: settlement.budget.periodStartedAt }
            : {}),
          ...(settlement.budget.periodEndsAt
            ? { periodEndsAt: settlement.budget.periodEndsAt }
            : {}),
          ...(settlement.budget.lastSettlementAt
            ? { settledAt: settlement.budget.lastSettlementAt }
            : {}),
          metadataJson: JSON.stringify({
            contractBudgetId: delegatedBudget.contractBudgetId,
          }),
        }),
      fallback:
        'BuddyPie could not record the delegated-budget sandbox launch charge.',
    })
  })
}
