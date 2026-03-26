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
  parseJsonBody,
} from '~/routes/api/x402/-_helpers'

type SshRequestBody = {
  expiresInMinutes?: number
}

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

export const Route = createFileRoute('/api/x402/sandboxes/$sandboxId/ssh')({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        runRouteProgram(
          Effect.gen(function*() {
            const [{ createTerminalAccessWithPayment }] = yield* Effect.tryPromise({
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
            const body = yield* Effect.tryPromise({
              try: () => parseJsonBody<SshRequestBody>(request),
              catch: (error) =>
                new ValidationError({
                  message: normalizeUnknownMessage(
                    error,
                    'The SSH access request payload is invalid.',
                  ),
                  cause: error,
                }),
            })
            const expiresInMinutes =
              Number.isInteger(body?.expiresInMinutes) &&
              (body?.expiresInMinutes ?? 0) > 0
                ? body?.expiresInMinutes
                : 60

            return yield* executeX402PaymentRoute({
              request,
              context: getOwnedSandboxRouteContextProgram(params.sandboxId),
              amountUsdCents: ({ sandbox }) =>
                getBillingEventPriceUsdCents(
                  sandbox.agentPresetId ?? 'general-engineer',
                  'ssh_access',
                ),
              resourceDescription: ({ sandbox }) =>
                `Generate SSH access for ${sandbox.repoName}.`,
              execute: () =>
                createTerminalAccessWithPayment(
                  params.sandboxId,
                  expiresInMinutes,
                  'x402',
                ),
              recordCharge: (auth, settlement) =>
                Effect.tryPromise({
                  try: () =>
                    auth.convex.mutation(api.billing.recordX402DirectCharge, {
                      sandboxId: auth.sandbox._id,
                      agentPresetId: auth.sandbox.agentPresetId ?? 'general-engineer',
                      eventType: 'ssh_access',
                      amountUsdCents: getBillingEventPriceUsdCents(
                        auth.sandbox.agentPresetId ?? 'general-engineer',
                        'ssh_access',
                      ),
                      idempotencyKey: `x402:ssh_access:${settlement.transaction}`,
                      description: 'Generated Daytona SSH access.',
                      quantitySummary: `expires:${expiresInMinutes}`,
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
                        'BuddyPie could not record the x402 SSH charge.',
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
