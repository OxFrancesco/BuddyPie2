import { Effect } from 'effect'
import type { Id } from 'convex/_generated/dataModel'
import { ConvexService, X402Service } from '~/lib/server/effect/services'
import type { DomainError } from '~/lib/server/effect/errors'

type AuthenticatedRouteContext = Awaited<
  ReturnType<typeof import('~/lib/server/authenticated-convex').getAuthenticatedConvexClient>
>

export type OwnedSandboxRouteContext = AuthenticatedRouteContext & {
  sandbox: Awaited<
    ReturnType<Awaited<ReturnType<typeof import('~/lib/server/authenticated-convex').getAuthenticatedConvexClient>>['convex']['query']>
  >
}

export type X402Settlement = Awaited<
  ReturnType<
    Extract<Awaited<ReturnType<typeof import('~/lib/server/x402').requireX402Payment>>, { ok: true }>['settle']
  >
>

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
}

export async function parseJsonBody<T>(request: Request) {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

export function getAuthenticatedRouteContextProgram() {
  return Effect.gen(function*() {
    const convex = yield* ConvexService
    yield* convex.ensureCurrentUser

    return convex.context
  })
}

export function getOwnedSandboxRouteContextProgram(sandboxId: string) {
  return Effect.gen(function*() {
    const convex = yield* ConvexService
    yield* convex.ensureCurrentUser
    const sandbox = yield* convex.getOwnedSandbox(sandboxId)

    return {
      ...convex.context,
      sandbox,
    }
  })
}

export function executeX402PaymentRoute<TContext, TResult, R>(args: {
  request: Request
  context: Effect.Effect<TContext, DomainError, R>
  amountUsdCents: (context: TContext) => number
  resourceDescription: (context: TContext) => string
  execute: (context: TContext) => Effect.Effect<TResult, DomainError, R>
  recordCharge: (
    context: TContext,
    settlement: X402Settlement,
    result: TResult,
  ) => Effect.Effect<void, DomainError, R>
  shouldSettle?: (result: TResult) => boolean
  success?: (result: TResult) => Response
}) {
  return Effect.gen(function*() {
    const context = yield* args.context
    const x402 = yield* X402Service
    const payment = yield* x402.requirePayment({
      request: args.request,
      amountUsdCents: args.amountUsdCents(context),
      resourceDescription: args.resourceDescription(context),
    })

    if (!payment.ok) {
      return payment.response
    }

    const result = yield* args.execute(context)

    if (args.shouldSettle && !args.shouldSettle(result)) {
      return args.success ? args.success(result) : Response.json(result)
    }

    const settlement = yield* x402.settlePayment(payment)
    yield* args.recordCharge(context, settlement, result)

    return args.success ? args.success(result) : Response.json(result)
  })
}

export function sandboxIdParamToId(sandboxId: string) {
  return sandboxId as Id<'sandboxes'>
}
