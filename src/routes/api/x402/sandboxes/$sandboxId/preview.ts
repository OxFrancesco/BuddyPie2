import { createFileRoute } from '@tanstack/react-router'
import { api } from 'convex/_generated/api'
import { Effect } from 'effect'
import { getBillingEventPriceUsdCents } from '~/lib/billing/catalog'
import { DaytonaService } from '~/lib/server/effect/services'
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

type PreviewRequestBody = {
  port: number
}

const APP_PREVIEW_PORT_MIN = 3000
const APP_PREVIEW_PORT_MAX = 9999

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function isValidAppPreviewPort(port: number) {
  return (
    Number.isInteger(port) &&
    port >= APP_PREVIEW_PORT_MIN &&
    port <= APP_PREVIEW_PORT_MAX
  )
}

export const Route = createFileRoute('/api/x402/sandboxes/$sandboxId/preview')({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        runRouteProgram(
          Effect.gen(function*() {
            const [{ ensureAppPreviewServerWithPayment }] = yield* Effect.tryPromise({
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
              try: () => parseJsonBody<PreviewRequestBody>(request),
              catch: (error) =>
                new ValidationError({
                  message: normalizeUnknownMessage(
                    error,
                    'The preview request payload is invalid.',
                  ),
                  cause: error,
                }),
            })
            const port = Number(body?.port)

            if (!isValidAppPreviewPort(port)) {
              return yield* Effect.fail(
                new ValidationError({
                  message: `Choose a valid preview port between ${APP_PREVIEW_PORT_MIN} and ${APP_PREVIEW_PORT_MAX}.`,
                }),
              )
            }

            const auth = yield* getOwnedSandboxRouteContextProgram(params.sandboxId)

            if (!auth.sandbox.daytonaSandboxId || !auth.sandbox.workspacePath) {
              return yield* Effect.fail(
                new ValidationError({
                  message: 'Sandbox runtime is not ready for app preview yet.',
                }),
              )
            }

            const daytona = yield* DaytonaService
            const previewStatus = yield* daytona.getSandboxAppPreviewStatus({
              daytonaSandboxId: auth.sandbox.daytonaSandboxId,
              workspacePath: auth.sandbox.workspacePath,
              previewAppPath: auth.sandbox.previewAppPath,
              agentPresetId: auth.sandbox.agentPresetId,
              port,
            })

            if (previewStatus.status === 'already-running') {
              return Response.json(previewStatus)
            }

            return yield* executeX402PaymentRoute({
              request,
              context: Effect.succeed(auth),
              amountUsdCents: ({ sandbox }) =>
                getBillingEventPriceUsdCents(
                  sandbox.agentPresetId ?? 'general-engineer',
                  'preview_boot',
                ),
              resourceDescription: ({ sandbox }) =>
                `Boot app preview on port ${port} for ${sandbox.repoName}.`,
              execute: () =>
                ensureAppPreviewServerWithPayment(
                  params.sandboxId,
                  port,
                  'x402',
                ),
              shouldSettle: (result) => result.status === 'started',
              recordCharge: (routeAuth, settlement) =>
                Effect.tryPromise({
                  try: () =>
                    routeAuth.convex.mutation(api.billing.recordX402DirectCharge, {
                      sandboxId: routeAuth.sandbox._id,
                      agentPresetId:
                        routeAuth.sandbox.agentPresetId ?? 'general-engineer',
                      eventType: 'preview_boot',
                      amountUsdCents: getBillingEventPriceUsdCents(
                        routeAuth.sandbox.agentPresetId ?? 'general-engineer',
                        'preview_boot',
                      ),
                      idempotencyKey: `x402:preview_boot:${settlement.transaction}`,
                      description: `Preview boot on port ${port}`,
                      quantitySummary: `port:${port}`,
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
                        'BuddyPie could not record the x402 preview-boot charge.',
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
