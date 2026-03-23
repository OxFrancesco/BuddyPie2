import { randomUUID } from 'node:crypto'
import { api } from 'convex/_generated/api'
import type { Doc, Id } from 'convex/_generated/dataModel'
import {
  getBillingEventPriceUsdCents,
  type BillingPaymentMethod,
} from '../../../../convex/lib/billingConfig'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'
import {
  assertDelegatedBudgetAllowanceOrThrow,
  settleDelegatedBudgetOnchain,
} from '~/lib/server/delegated-budget'

export async function requireDelegatedBudgetAllowance(args: {
  requiredAmountUsdCents: number
  actionLabel: string
}): Promise<Doc<'delegatedBudgets'>> {
  const { convex } = await getAuthenticatedConvexClient()
  const delegatedBudget = await convex.query(
    api.billing.currentDelegatedBudget,
    {},
  )

  if (!delegatedBudget) {
    throw new Error(
      'Set up an active delegated budget before using that payment rail.',
    )
  }

  await assertDelegatedBudgetAllowanceOrThrow({
    budget: delegatedBudget,
    requiredAmountUsdCents: args.requiredAmountUsdCents,
    actionLabel: args.actionLabel,
  })

  return delegatedBudget
}

export async function withPaidSandboxAction<T>(args: {
  sandboxId: Id<'sandboxes'>
  agentPresetId: string
  eventType: 'preview_boot' | 'ssh_access' | 'web_terminal'
  paymentMethod: BillingPaymentMethod
  quantitySummary?: string
  description: string
  action: () => Promise<T>
  shouldCapture?: (result: T) => boolean
  releaseReason?: string
}) {
  const { convex } = await getAuthenticatedConvexClient()
  const amountUsdCents = getBillingEventPriceUsdCents(
    args.agentPresetId,
    args.eventType,
  )

  if (args.paymentMethod === 'x402') {
    return await args.action()
  }

  if (args.paymentMethod === 'delegated_budget') {
    let delegatedBudget: Awaited<
      ReturnType<typeof requireDelegatedBudgetAllowance>
    > | null = null
    if (!args.shouldCapture) {
      delegatedBudget = await requireDelegatedBudgetAllowance({
        requiredAmountUsdCents: amountUsdCents,
        actionLabel: args.description,
      })
    }

    const result = await args.action()

    if (args.shouldCapture && !args.shouldCapture(result)) {
      return result
    }

    delegatedBudget ??= await requireDelegatedBudgetAllowance({
      requiredAmountUsdCents: amountUsdCents,
      actionLabel: args.description,
    })

    const idempotencyKey = `${args.eventType}:${args.sandboxId}:${randomUUID()}`
    const settlement = await settleDelegatedBudgetOnchain({
      budget: delegatedBudget,
      amountUsdCents,
      idempotencyKey,
    })

    await convex.mutation(api.billing.recordDelegatedBudgetCharge, {
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
    })

    return result
  }

  const hold = await convex.mutation(api.billing.holdCredits, {
    sandboxId: args.sandboxId,
    agentPresetId: args.agentPresetId,
    purpose: args.eventType,
    amountUsdCents,
    idempotencyKey: `${args.eventType}:${args.sandboxId}:${Date.now()}`,
    quantitySummary: args.quantitySummary,
    description: args.description,
  })

  try {
    const result = await args.action()

    if (args.shouldCapture && !args.shouldCapture(result)) {
      await convex.mutation(api.billing.releaseCreditHold, {
        holdId: hold._id,
        reason:
          args.releaseReason ?? `No charge captured for ${args.eventType}.`,
      })

      return result
    }

    await convex.mutation(api.billing.captureCreditHold, {
      holdId: hold._id,
      sandboxId: args.sandboxId,
      eventType: args.eventType,
      idempotencyKey: `capture:${hold.idempotencyKey}`,
      description: args.description,
      quantitySummary: args.quantitySummary,
      costUsdCents: amountUsdCents,
    })

    return result
  } catch (error) {
    try {
      await convex.mutation(api.billing.releaseCreditHold, {
        holdId: hold._id,
        reason:
          args.releaseReason ?? `${args.eventType} failed before capture.`,
      })
    } catch {
      // Best effort cleanup if the action throws after the hold is created.
    }

    throw error
  }
}

export async function captureDelegatedLaunchCharge(args: {
  sandboxId: Id<'sandboxes'>
  agentPresetId: string
  repoName: string
  repoBranch?: string
}) {
  const amountUsdCents = getBillingEventPriceUsdCents(
    args.agentPresetId,
    'sandbox_launch',
  )
  const delegatedBudget = await requireDelegatedBudgetAllowance({
    requiredAmountUsdCents: amountUsdCents,
    actionLabel: `launching OpenCode for ${args.repoName}`,
  })
  const { convex } = await getAuthenticatedConvexClient()
  const idempotencyKey = `sandbox_launch:${args.sandboxId}:${randomUUID()}`
  const settlement = await settleDelegatedBudgetOnchain({
    budget: delegatedBudget,
    amountUsdCents,
    idempotencyKey,
  })

  await convex.mutation(api.billing.recordDelegatedBudgetCharge, {
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
  })
}
