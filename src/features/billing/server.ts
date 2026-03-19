import { createServerFn } from '@tanstack/react-start'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { clerkClient } from '@clerk/tanstack-react-start/server'
import {
  normalizeClerkSubscription,
  type ClerkBillingSubscription,
} from '~/features/billing/clerk-billing'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'

function isMissingSubscriptionError(error: unknown) {
  return (
    error instanceof Error &&
    /(404|not found|no .*subscription|billing subscription)/i.test(error.message)
  )
}

function isBillingDisabledError(error: unknown) {
  return (
    error instanceof Error &&
    /(billing.+disabled|disabled.+billing|billing.+not enabled|not enabled.+billing)/i.test(
      error.message,
    )
  )
}

export const syncCurrentClerkBillingState = createServerFn({ method: 'POST' }).handler(
  async () => {
    const { convex, userId } = await getAuthenticatedConvexClient()
    await convex.mutation(api.user.ensureCurrentUser, {})

    const client = await clerkClient()
    let subscription: ClerkBillingSubscription | null = null

    try {
      subscription = (await client.billing.getUserBillingSubscription(
        userId,
      )) as ClerkBillingSubscription
    } catch (error) {
      if (isBillingDisabledError(error)) {
        return {
          synced: false,
          reason: 'billing_disabled' as const,
        }
      }

      if (isMissingSubscriptionError(error)) {
        return {
          synced: false,
          reason: 'missing_subscription' as const,
        }
      }

      throw error
    }

    const normalized = normalizeClerkSubscription(userId, subscription)

    if (!normalized) {
      return {
        synced: false,
        reason: 'missing_subscription' as const,
      }
    }

    const result = await convex.mutation(
      api.billing.applySubscriptionCreditGrant,
      {
        clerkSubscriptionId: normalized.clerkSubscriptionId,
        clerkSubscriptionItemId: normalized.clerkSubscriptionItemId,
        status: normalized.status,
        planSlug: normalized.planSlug,
        planName: normalized.planName,
        planPeriod: normalized.planPeriod,
        periodStart: normalized.periodStart,
        periodEnd: normalized.periodEnd,
        rawJson: normalized.rawJson,
      },
    )

    return {
      synced: true,
      reason: 'synced' as const,
      ...result,
    }
  },
)

type CreateDelegatedBudgetInput = {
  contractBudgetId: string
  budgetType: 'fixed' | 'periodic'
  interval?: 'day' | 'week' | 'month' | null
  configuredAmountUsdCents: number
  remainingAmountUsdCents: number
  periodStartedAt?: number | null
  periodEndsAt?: number | null
  ownerAddress: string
  delegatorSmartAccount: string
  delegateAddress: string
  treasuryAddress: string
  delegationJson: string
  delegationHash: string
  delegationExpiresAt?: number | null
  approvalMode: 'exact' | 'standing'
  approvalTxHash?: string
  createTxHash?: string
}

type SyncDelegatedBudgetInput = {
  delegatedBudgetId: string
  lastSettlementTxHash?: string
}

type RevokeDelegatedBudgetInput = {
  delegatedBudgetId: string
  revokeTxHash: string
}

export const createDelegatedBudget = createServerFn({ method: 'POST' })
  .inputValidator((data: CreateDelegatedBudgetInput) => data)
  .handler(async ({ data }) => {
    const { convex } = await getAuthenticatedConvexClient()
    await convex.mutation(api.user.ensureCurrentUser, {})

    return await convex.mutation(api.billing.createDelegatedBudget, {
      contractBudgetId: data.contractBudgetId,
      budgetType: data.budgetType,
      ...(data.interval ? { interval: data.interval } : {}),
      configuredAmountUsdCents: data.configuredAmountUsdCents,
      remainingAmountUsdCents: data.remainingAmountUsdCents,
      ...(data.periodStartedAt ? { periodStartedAt: data.periodStartedAt } : {}),
      ...(data.periodEndsAt ? { periodEndsAt: data.periodEndsAt } : {}),
      ownerAddress: data.ownerAddress,
      delegatorSmartAccount: data.delegatorSmartAccount,
      delegateAddress: data.delegateAddress,
      treasuryAddress: data.treasuryAddress,
      delegationJson: data.delegationJson,
      delegationHash: data.delegationHash,
      ...(data.delegationExpiresAt
        ? { delegationExpiresAt: data.delegationExpiresAt }
        : {}),
      approvalMode: data.approvalMode,
      ...(data.approvalTxHash ? { approvalTxHash: data.approvalTxHash } : {}),
      ...(data.createTxHash ? { createTxHash: data.createTxHash } : {}),
    })
  })

export const refreshDelegatedBudgetState = createServerFn({ method: 'POST' })
  .inputValidator((data: SyncDelegatedBudgetInput) => data)
  .handler(async ({ data }) => {
    const { convex } = await getAuthenticatedConvexClient()
    const { readDelegatedBudgetOnchain } = await import(
      '~/lib/server/delegated-budget'
    )
    const budget = await convex.query(api.billing.delegatedBudgetById, {
      delegatedBudgetId: data.delegatedBudgetId as Id<'delegatedBudgets'>,
    })

    if (!budget) {
      throw new Error('Delegated budget not found.')
    }

    const onchainBudget = await readDelegatedBudgetOnchain(budget)

    return await convex.mutation(api.billing.refreshDelegatedBudgetState, {
      delegatedBudgetId: data.delegatedBudgetId as Id<'delegatedBudgets'>,
      status: onchainBudget.status,
      remainingAmountUsdCents: onchainBudget.remainingAmountUsdCents,
      ...(onchainBudget.periodStartedAt
        ? { periodStartedAt: onchainBudget.periodStartedAt }
        : {}),
      ...(onchainBudget.periodEndsAt
        ? { periodEndsAt: onchainBudget.periodEndsAt }
        : {}),
      ...(onchainBudget.lastSettlementAt
        ? { lastSettlementAt: onchainBudget.lastSettlementAt }
        : {}),
      ...(onchainBudget.lastRevokedAt
        ? { lastRevokedAt: onchainBudget.lastRevokedAt }
        : {}),
      ...(data.lastSettlementTxHash
        ? { lastSettlementTxHash: data.lastSettlementTxHash }
        : {}),
    })
  })

export const revokeDelegatedBudget = createServerFn({ method: 'POST' })
  .inputValidator((data: RevokeDelegatedBudgetInput) => data)
  .handler(async ({ data }) => {
    const { convex } = await getAuthenticatedConvexClient()
    const { readDelegatedBudgetOnchain } = await import(
      '~/lib/server/delegated-budget'
    )
    const budget = await convex.query(api.billing.delegatedBudgetById, {
      delegatedBudgetId: data.delegatedBudgetId as Id<'delegatedBudgets'>,
    })

    if (!budget) {
      throw new Error('Delegated budget not found.')
    }

    const onchainBudget = await readDelegatedBudgetOnchain(budget)

    return await convex.mutation(api.billing.revokeDelegatedBudget, {
      delegatedBudgetId: data.delegatedBudgetId as Id<'delegatedBudgets'>,
      revokeTxHash: data.revokeTxHash,
      remainingAmountUsdCents: onchainBudget.remainingAmountUsdCents,
      ...(onchainBudget.lastRevokedAt
        ? { lastRevokedAt: onchainBudget.lastRevokedAt }
        : {}),
    })
  })
