import { createServerFn } from '@tanstack/react-start'
import { api } from 'convex/_generated/api'
import type { OpenCodeAgentPresetId } from '~/lib/opencode/presets'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'

type FundingTopupInput = {
  amountUsdCents: number
}

type AgentReserveAllocationInput = {
  agentPresetId: OpenCodeAgentPresetId
  amountUsdCents: number
}

export const recordManualFundingTopup = createServerFn({ method: 'POST' })
  .inputValidator((data: FundingTopupInput) => data)
  .handler(async ({ data }) => {
    const { convex } = await getAuthenticatedConvexClient()
    await convex.mutation(api.user.ensureCurrentUser, {})

    return await convex.mutation(api.billing.recordFundingTopup, {
      amountUsdCents: data.amountUsdCents,
      paymentReference: `manual-testnet-${Date.now()}`,
      idempotencyKey: `manual-topup:${Date.now()}:${data.amountUsdCents}`,
      source: 'manual_testnet',
      metadataJson:
        'Settled locally for the BuddyPie reserve MVP. Replace this with the x402 seller callback.',
    })
  })

export const allocateAgentReserve = createServerFn({ method: 'POST' })
  .inputValidator((data: AgentReserveAllocationInput) => data)
  .handler(async ({ data }) => {
    const { convex } = await getAuthenticatedConvexClient()
    await convex.mutation(api.user.ensureCurrentUser, {})

    return await convex.mutation(api.billing.allocateReserve, {
      agentPresetId: data.agentPresetId,
      amountUsdCents: data.amountUsdCents,
    })
  })
