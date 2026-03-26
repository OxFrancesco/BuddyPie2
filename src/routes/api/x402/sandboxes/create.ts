import { createFileRoute } from '@tanstack/react-router'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { Effect } from 'effect'
import { getBillingEventPriceUsdCents } from '~/lib/billing/catalog'
import {
  ValidationError,
  PaymentError,
} from '~/lib/server/effect/errors'
import { runRouteProgram } from '~/lib/server/effect/runtime'
import {
  executeX402PaymentRoute,
  getAuthenticatedRouteContextProgram,
  parseJsonBody,
} from '~/routes/api/x402/-_helpers'
import {
  getSandboxLaunchQuantitySummary,
  normalizeSandboxInput,
  type CreateSandboxInput,
} from '~/lib/sandboxes'

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function recordDirectCharge<T>(options: {
  auth: Awaited<
    ReturnType<typeof import('~/lib/server/authenticated-convex').getAuthenticatedConvexClient>
  >
  result: T & {
    sandboxId: string
    agentPresetId: string
  }
  amountUsdCents: number
  idempotencyKey: string
  description: string
  quantitySummary?: string
  settlement: {
    transaction: string
    network: string
    payer?: string
  }
  metadata?: Record<string, unknown>
}) {
  return Effect.tryPromise({
    try: () =>
      options.auth.convex.mutation(api.billing.recordX402DirectCharge, {
        sandboxId: options.result.sandboxId as Id<'sandboxes'>,
        agentPresetId: options.result.agentPresetId,
        eventType: 'sandbox_launch',
        amountUsdCents: options.amountUsdCents,
        idempotencyKey: options.idempotencyKey,
        description: options.description,
        quantitySummary: options.quantitySummary,
        externalReference: options.settlement.transaction,
        metadataJson: JSON.stringify({
          network: options.settlement.network,
          payer: options.settlement.payer,
          ...(options.metadata ?? {}),
        }),
      }),
    catch: (error) =>
      new PaymentError({
        message: normalizeUnknownMessage(
          error,
          'BuddyPie could not record the x402 charge.',
        ),
        cause: error,
      }),
  })
}

export const Route = createFileRoute('/api/x402/sandboxes/create')({
  server: {
    handlers: {
      POST: ({ request }) =>
        runRouteProgram(
          Effect.gen(function*() {
            const [{ createSandboxWithPayment }] = yield* Effect.tryPromise({
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
              try: () => parseJsonBody<CreateSandboxInput>(request),
              catch: (error) =>
                new ValidationError({
                  message: normalizeUnknownMessage(
                    error,
                    'A JSON payload is required to create a sandbox.',
                  ),
                  cause: error,
                }),
            })

            if (!body) {
              return yield* Effect.fail(
                new ValidationError({
                  message: 'A JSON payload is required to create a sandbox.',
                }),
              )
            }

            const normalized = yield* Effect.try({
              try: () => normalizeSandboxInput(body),
              catch: (error) =>
                new ValidationError({
                  message: normalizeUnknownMessage(
                    error,
                    'Sandbox input is invalid.',
                  ),
                  cause: error,
                }),
            })

            return yield* executeX402PaymentRoute({
              request,
              context: getAuthenticatedRouteContextProgram(),
              amountUsdCents: () =>
                getBillingEventPriceUsdCents(
                  normalized.agentPresetId,
                  'sandbox_launch',
                ),
              resourceDescription: () =>
                `Launch ${normalized.repoName} with ${normalized.agentLabel}.`,
              execute: () =>
                createSandboxWithPayment(
                  {
                    ...body,
                    paymentMethod: 'x402',
                  },
                  'x402',
                ),
              recordCharge: (auth, settlement, result) =>
                recordDirectCharge({
                  auth,
                  result,
                  amountUsdCents: getBillingEventPriceUsdCents(
                    normalized.agentPresetId,
                    'sandbox_launch',
                  ),
                  idempotencyKey: `x402:sandbox_launch:${settlement.transaction}`,
                  description: `OpenCode sandbox launch for ${normalized.repoName}`,
                  quantitySummary: getSandboxLaunchQuantitySummary({
                    repoUrl: normalized.repoUrl,
                    branch: normalized.branch,
                  }),
                  settlement,
                }),
            })
          }),
        ),
    },
  },
})
