import { createFileRoute } from '@tanstack/react-router'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { getBillingEventPriceUsdCents } from '~/lib/billing/catalog'
import { getSandboxLaunchQuantitySummary } from '~/lib/sandboxes'

export const Route = createFileRoute('/api/x402/sandboxes/$sandboxId/restart')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const [
          { restartSandboxWithPayment },
          { requireX402Payment },
          { getOwnedSandboxRouteContext, jsonError },
        ] = await Promise.all([
          import('~/features/sandboxes/runtime.server'),
          import('~/lib/server/x402'),
          import('~/routes/api/x402/-_helpers'),
        ])
        const auth = await getOwnedSandboxRouteContext(params.sandboxId)

        if (!auth.ok) {
          return auth.response
        }

        const agentPresetId = auth.sandbox.agentPresetId ?? 'general-engineer'
        const amountUsdCents = getBillingEventPriceUsdCents(
          agentPresetId,
          'sandbox_launch',
        )

        let payment

        try {
          payment = await requireX402Payment({
            request,
            amountUsdCents,
            resourceDescription: `Restart ${auth.sandbox.repoName} with ${agentPresetId}.`,
          })
        } catch (error) {
          return jsonError(
            error instanceof Error ? error.message : 'x402 is not configured correctly.',
            500,
          )
        }

        if (!payment.ok) {
          return payment.response
        }

        try {
          const result = await restartSandboxWithPayment(params.sandboxId, 'x402')
          const settlement = await payment.settle()

          await auth.convex.mutation(api.billing.recordX402DirectCharge, {
            sandboxId: result.sandboxId as Id<'sandboxes'>,
            agentPresetId: result.agentPresetId,
            eventType: 'sandbox_launch',
            amountUsdCents,
            idempotencyKey: `x402:sandbox_restart:${settlement.transaction}`,
            description: `Restarted ${auth.sandbox.repoName}`,
            quantitySummary: getSandboxLaunchQuantitySummary({
              repoUrl: auth.sandbox.repoUrl,
              branch: auth.sandbox.repoBranch,
            }),
            externalReference: settlement.transaction,
            metadataJson: JSON.stringify({
              network: settlement.network,
              payer: settlement.payer,
              restartedFromSandboxId: auth.sandbox._id,
            }),
          })

          return Response.json(result)
        } catch (error) {
          return jsonError(
            error instanceof Error ? error.message : 'Sandbox restart failed.',
            400,
          )
        }
      },
    },
  },
})
