import { httpRouter } from 'convex/server'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { httpAction } from './_generated/server'

const http = httpRouter()

async function requireAuthedRequest(ctx: ActionCtx) {
  const identity = await ctx.auth.getUserIdentity()

  if (!identity) {
    return {
      ok: false as const,
      response: Response.json(
        { error: 'You must be signed in to continue.' },
        { status: 401 },
      ),
    }
  }

  return {
    ok: true as const,
  }
}

http.route({
  path: '/billing/manual-topup',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await requireAuthedRequest(ctx)

    if (!auth.ok) {
      return auth.response
    }

    const body = (await req.json()) as {
      amountUsdCents?: number
      paymentReference?: string
      idempotencyKey?: string
      source?: 'manual_testnet' | 'x402_settled'
      grossTokenAmount?: string
      metadataJson?: string
    }
    const amountUsdCents = body.amountUsdCents

    if (
      !Number.isInteger(amountUsdCents) ||
      amountUsdCents <= 0 ||
      !body.paymentReference ||
      !body.idempotencyKey ||
      !body.source
    ) {
      return Response.json(
        { error: 'Invalid top-up payload.' },
        { status: 400 },
      )
    }

    const paymentReference = body.paymentReference as string
    const idempotencyKey = body.idempotencyKey as string
    const source = body.source as 'manual_testnet' | 'x402_settled'

    await ctx.runMutation(api.user.ensureCurrentUser, {})

    const account = await ctx.runMutation(internal.billing.recordFundingTopup, {
      amountUsdCents,
      paymentReference,
      idempotencyKey,
      source,
      grossTokenAmount: body.grossTokenAmount,
      metadataJson: body.metadataJson,
    })

    return Response.json(account, { status: 200 })
  }),
})

http.route({
  path: '/billing/leases/create',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await requireAuthedRequest(ctx)

    if (!auth.ok) {
      return auth.response
    }

    const body = (await req.json()) as {
      sandboxId?: string
      eventType?: 'preview_boot' | 'ssh_access' | 'web_terminal'
      idempotencyKey?: string
      quantitySummary?: string
    }

    if (
      !body.sandboxId ||
      !body.eventType ||
      !body.idempotencyKey
    ) {
      return Response.json({ error: 'Invalid lease payload.' }, { status: 400 })
    }

    await ctx.runMutation(api.user.ensureCurrentUser, {})

    const lease = await ctx.runMutation(internal.billing.createSandboxEventLease, {
      sandboxId: body.sandboxId as Id<'sandboxes'>,
      eventType: body.eventType,
      idempotencyKey: body.idempotencyKey,
      quantitySummary: body.quantitySummary,
    })

    return Response.json(lease, { status: 200 })
  }),
})

http.route({
  path: '/billing/leases/capture',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await requireAuthedRequest(ctx)

    if (!auth.ok) {
      return auth.response
    }

    const body = (await req.json()) as {
      leaseId?: string
      sandboxId?: string
      eventType?: 'preview_boot' | 'ssh_access' | 'web_terminal'
      idempotencyKey?: string
      description?: string
      quantitySummary?: string
    }

    if (
      !body.leaseId ||
      !body.sandboxId ||
      !body.eventType ||
      !body.idempotencyKey ||
      !body.description
    ) {
      return Response.json(
        { error: 'Invalid lease capture payload.' },
        { status: 400 },
      )
    }

    await ctx.runMutation(api.user.ensureCurrentUser, {})

    const usage = await ctx.runMutation(internal.billing.captureSandboxEventLease, {
      leaseId: body.leaseId as Id<'reserveLeases'>,
      sandboxId: body.sandboxId as Id<'sandboxes'>,
      eventType: body.eventType,
      idempotencyKey: body.idempotencyKey,
      description: body.description,
      quantitySummary: body.quantitySummary,
    })

    return Response.json(usage, { status: 200 })
  }),
})

http.route({
  path: '/billing/leases/release',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await requireAuthedRequest(ctx)

    if (!auth.ok) {
      return auth.response
    }

    const body = (await req.json()) as {
      leaseId?: string
      reason?: string
    }

    if (!body.leaseId || !body.reason) {
      return Response.json(
        { error: 'Invalid lease release payload.' },
        { status: 400 },
      )
    }

    await ctx.runMutation(api.user.ensureCurrentUser, {})

    const lease = await ctx.runMutation(internal.billing.releaseLease, {
      leaseId: body.leaseId as Id<'reserveLeases'>,
      reason: body.reason,
    })

    return Response.json(lease, { status: 200 })
  }),
})

export default http
