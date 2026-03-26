import { createFileRoute } from '@tanstack/react-router'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { Effect } from 'effect'
import { getBillingEventPriceUsdCents } from '~/lib/billing/catalog'
import {
  PaymentError,
  ValidationError,
} from '~/lib/server/effect/errors'
import { runRouteProgram } from '~/lib/server/effect/runtime'
import {
  executeX402PaymentRoute,
  getOwnedSandboxRouteContextProgram,
} from '~/routes/api/x402/-_helpers'
import { getSandboxLaunchQuantitySummary } from '~/lib/sandboxes'

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

export const Route = createFileRoute('/api/x402/sandboxes/$sandboxId/restart')({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        runRouteProgram(
          Effect.gen(function*() {
            const [{ restartSandboxWithPayment }] = yield* Effect.tryPromise({
              try: () => Promise.all([import('~/features/sandboxes/runtime.server')]),
              catch: (error) =>
                new ValidationError({
                  message: normalizeUnknownMessage(
                    error,
                    'BuddyPie could not load the sandbox runtime.',
                  ),
                  cause: error,
                }),
            })

            return yield* executeX402PaymentRoute({
              request,
              context: getOwnedSandboxRouteContextProgram(params.sandboxId),
              amountUsdCents: ({ sandbox }) =>
                getBillingEventPriceUsdCents(
                  sandbox.agentPresetId ?? 'general-engineer',
                  'sandbox_launch',
                ),
              resourceDescription: ({ sandbox }) =>
                `Restart ${sandbox.repoName} with ${sandbox.agentPresetId ?? 'general-engineer'}.`,
              execute: () => restartSandboxWithPayment(params.sandboxId, 'x402'),
              recordCharge: (auth, settlement, result) =>
                Effect.tryPromise({
                  try: () =>
                    auth.convex.mutation(api.billing.recordX402DirectCharge, {
                      sandboxId: result.sandboxId as Id<'sandboxes'>,
                      agentPresetId: result.agentPresetId,
                      eventType: 'sandbox_launch',
                      amountUsdCents: getBillingEventPriceUsdCents(
                        auth.sandbox.agentPresetId ?? 'general-engineer',
                        'sandbox_launch',
                      ),
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
                    }),
                  catch: (error) =>
                    new PaymentError({
                      message: normalizeUnknownMessage(
                        error,
                        'BuddyPie could not record the x402 restart charge.',
                      ),
                      cause: error,
                    }),
                }),
            })
          }),
        ),
    },
  },
})
