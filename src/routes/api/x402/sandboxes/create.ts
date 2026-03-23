import { createFileRoute } from '@tanstack/react-router'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { getBillingEventPriceUsdCents } from '~/lib/billing/catalog'
import {
  getSandboxLaunchQuantitySummary,
  normalizeSandboxInput,
  type CreateSandboxInput,
} from '~/lib/sandboxes'

export const Route = createFileRoute('/api/x402/sandboxes/create')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [
          { createSandboxWithPayment },
          { requireX402Payment },
          { getAuthenticatedRouteContext, jsonError, parseJsonBody },
        ] = await Promise.all([
          import('~/features/sandboxes/runtime.server'),
          import('~/lib/server/x402'),
          import('~/routes/api/x402/-_helpers'),
        ])
        const auth = await getAuthenticatedRouteContext()

        if (!auth.ok) {
          return auth.response
        }

        const body = await parseJsonBody<CreateSandboxInput>(request)

        if (!body) {
          return jsonError('A JSON payload is required to create a sandbox.', 400)
        }

        let normalized: ReturnType<typeof normalizeSandboxInput>

        try {
          normalized = normalizeSandboxInput(body)
        } catch (error) {
          return jsonError(
            error instanceof Error ? error.message : 'Sandbox input is invalid.',
            400,
          )
        }

        const amountUsdCents = getBillingEventPriceUsdCents(
          normalized.agentPresetId,
          'sandbox_launch',
        )

        let payment

        try {
          payment = await requireX402Payment({
            request,
            amountUsdCents,
            resourceDescription: `Launch ${normalized.repoName} with ${normalized.agentLabel}.`,
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
          const result = await createSandboxWithPayment(
            {
              ...body,
              paymentMethod: 'x402',
            },
            'x402',
          )
          const settlement = await payment.settle()

          await auth.convex.mutation(api.billing.recordX402DirectCharge, {
            sandboxId: result.sandboxId as Id<'sandboxes'>,
            agentPresetId: result.agentPresetId,
            eventType: 'sandbox_launch',
            amountUsdCents,
            idempotencyKey: `x402:sandbox_launch:${settlement.transaction}`,
            description: `OpenCode sandbox launch for ${normalized.repoName}`,
            quantitySummary: getSandboxLaunchQuantitySummary({
              repoUrl: normalized.repoUrl,
              branch: normalized.branch,
            }),
            externalReference: settlement.transaction,
            metadataJson: JSON.stringify({
              network: settlement.network,
              payer: settlement.payer,
            }),
          })

          return Response.json(result)
        } catch (error) {
          return jsonError(
            error instanceof Error ? error.message : 'Sandbox launch failed.',
            400,
          )
        }
      },
    },
  },
})
