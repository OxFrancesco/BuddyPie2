import { createFileRoute } from '@tanstack/react-router'
import { api } from 'convex/_generated/api'
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

const DAYTONA_WEB_TERMINAL_PORT = 22222

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

export const Route = createFileRoute('/api/x402/sandboxes/$sandboxId/web-terminal')({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        runRouteProgram(
          Effect.gen(function*() {
            const [{ getPortPreviewWithPayment }] = yield* Effect.tryPromise({
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
                  'web_terminal',
                ),
              resourceDescription: ({ sandbox }) =>
                `Open the Daytona web terminal for ${sandbox.repoName}.`,
              execute: () =>
                getPortPreviewWithPayment(
                  params.sandboxId,
                  DAYTONA_WEB_TERMINAL_PORT,
                  'x402',
                ),
              recordCharge: (auth, settlement) =>
                Effect.tryPromise({
                  try: () =>
                    auth.convex.mutation(api.billing.recordX402DirectCharge, {
                      sandboxId: auth.sandbox._id,
                      agentPresetId: auth.sandbox.agentPresetId ?? 'general-engineer',
                      eventType: 'web_terminal',
                      amountUsdCents: getBillingEventPriceUsdCents(
                        auth.sandbox.agentPresetId ?? 'general-engineer',
                        'web_terminal',
                      ),
                      idempotencyKey: `x402:web_terminal:${settlement.transaction}`,
                      description: 'Opened the Daytona web terminal.',
                      quantitySummary: `port:${DAYTONA_WEB_TERMINAL_PORT}`,
                      externalReference: settlement.transaction,
                      metadataJson: JSON.stringify({
                        network: settlement.network,
                        payer: settlement.payer,
                      }),
                    }),
                  catch: (error) =>
                    new PaymentError({
                      message: normalizeUnknownMessage(
                        error,
                        'BuddyPie could not record the x402 web-terminal charge.',
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
