import { httpRouter } from 'convex/server'
import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { httpAction } from './_generated/server'

const http = httpRouter()

type FundingTopupSource = 'manual_testnet' | 'x402_settled'

const X402_PROTOCOL_VERSION = 2
const DEFAULT_X402_FACILITATOR_URL = 'https://x402.org/facilitator'
const DEFAULT_X402_NETWORK = 'eip155:84532'
const DEFAULT_X402_USDC_ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DEFAULT_X402_MAX_TIMEOUT_SECONDS = 300
const USDC_ATOMIC_UNITS_PER_USD_CENT = 10_000

type FundingTopupBody = {
  amountUsdCents?: number
  paymentReference?: string
  idempotencyKey?: string
  source?: FundingTopupSource
  grossTokenAmount?: string
  metadataJson?: string
}

type X402PaymentRequirements = {
  scheme: 'exact'
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
}

type X402PaymentPayload = {
  x402Version?: number
  payload?: Record<string, unknown>
  resource?: Record<string, unknown>
  accepted?: Record<string, unknown>
}

type X402VerifyResponse = {
  isValid?: boolean
  payer?: string
  invalidReason?: string
}

type X402SettleResponse = {
  success?: boolean
  payer?: string
  transaction?: string
  network?: string
  errorReason?: string
  errorMessage?: string
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status })
}

function encodeBase64Json(value: unknown) {
  const json = JSON.stringify(value)

  if (typeof btoa === 'function') {
    return btoa(json)
  }

  return Buffer.from(json, 'utf8').toString('base64')
}

function decodeBase64Json<T>(value: string): T {
  const decoded =
    typeof atob === 'function'
      ? atob(value)
      : Buffer.from(value, 'base64').toString('utf8')

  return JSON.parse(decoded) as T
}

function usdCentsToUsdcAtomicUnits(amountUsdCents: number) {
  return String(amountUsdCents * USDC_ATOMIC_UNITS_PER_USD_CENT)
}

function requireValidTopupAmount(amountCandidate: number | undefined) {
  if (
    typeof amountCandidate !== 'number' ||
    !Number.isInteger(amountCandidate) ||
    amountCandidate <= 0
  ) {
    return null
  }

  return amountCandidate
}

function getX402Config() {
  const facilitatorUrl =
    process.env.X402_FACILITATOR_URL?.trim() || DEFAULT_X402_FACILITATOR_URL
  const network = process.env.X402_NETWORK?.trim() || DEFAULT_X402_NETWORK
  const asset = process.env.X402_USDC_ASSET?.trim() || DEFAULT_X402_USDC_ASSET
  const payTo = process.env.X402_PAY_TO_ADDRESS?.trim()
  const maxTimeoutCandidate = process.env.X402_MAX_TIMEOUT_SECONDS
    ? Number(process.env.X402_MAX_TIMEOUT_SECONDS)
    : DEFAULT_X402_MAX_TIMEOUT_SECONDS

  if (!payTo) {
    throw new Error('X402_PAY_TO_ADDRESS must be configured for x402 top-ups.')
  }

  if (!Number.isFinite(maxTimeoutCandidate) || maxTimeoutCandidate <= 0) {
    throw new Error('X402_MAX_TIMEOUT_SECONDS must be a positive number.')
  }

  if (network !== DEFAULT_X402_NETWORK) {
    throw new Error(
      `X402_NETWORK must stay ${DEFAULT_X402_NETWORK} while billing is pinned to Base Sepolia.`,
    )
  }

  return {
    facilitatorUrl,
    network,
    asset,
    payTo,
    maxTimeoutSeconds: Math.floor(maxTimeoutCandidate),
  }
}

function getPaymentHeader(req: Request) {
  return req.headers.get('payment-signature') ?? req.headers.get('x-payment')
}

async function parseFundingTopupBody(req: Request) {
  try {
    return (await req.json()) as FundingTopupBody
  } catch {
    return null
  }
}

function buildPaymentRequirements(
  amountUsdCents: number,
  config: ReturnType<typeof getX402Config>,
) {
  return {
    scheme: 'exact',
    network: config.network,
    amount: usdCentsToUsdcAtomicUnits(amountUsdCents),
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  } satisfies X402PaymentRequirements
}

function buildPaymentRequiredResponse(
  req: Request,
  amountUsdCents: number,
  requirements: X402PaymentRequirements,
) {
  return {
    x402Version: X402_PROTOCOL_VERSION,
    accepts: [
      {
        scheme: requirements.scheme,
        network: requirements.network,
        maxAmountRequired: requirements.amount,
        asset: requirements.asset,
        resource: req.url,
        mimeType: 'application/json',
        payTo: requirements.payTo,
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
        extra: {
          amountUsdCents,
        },
      },
    ],
    error: 'X-PAYMENT header is required',
  }
}

async function runFacilitatorVerification(
  config: ReturnType<typeof getX402Config>,
  paymentPayload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
) {
  const response = await fetch(`${config.facilitatorUrl}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      paymentPayload,
      paymentRequirements: requirements,
    }),
  })

  if (!response.ok) {
    throw new Error(`x402 verifier rejected the payment check (${response.status}).`)
  }

  return (await response.json()) as X402VerifyResponse
}

async function runFacilitatorSettlement(
  config: ReturnType<typeof getX402Config>,
  paymentPayload: X402PaymentPayload,
  requirements: X402PaymentRequirements,
) {
  const response = await fetch(`${config.facilitatorUrl}/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      paymentPayload,
      paymentRequirements: requirements,
    }),
  })

  if (!response.ok) {
    throw new Error(`x402 settlement failed (${response.status}).`)
  }

  return (await response.json()) as X402SettleResponse
}

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
  path: '/v1/wallet/topups',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await requireAuthedRequest(ctx)

    if (!auth.ok) {
      return auth.response
    }

    const body = await parseFundingTopupBody(req)

    if (!body) {
      return jsonError('Invalid JSON payload.', 400)
    }

    const amountUsdCents = requireValidTopupAmount(body.amountUsdCents)

    if (!amountUsdCents) {
      return jsonError('Invalid top-up payload.', 400)
    }

    let config: ReturnType<typeof getX402Config>

    try {
      config = getX402Config()
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : 'x402 is not configured.',
        500,
      )
    }

    const requirements = buildPaymentRequirements(amountUsdCents, config)
    const paymentRequiredPayload = buildPaymentRequiredResponse(
      req,
      amountUsdCents,
      requirements,
    )
    const paymentRequiredHeader = encodeBase64Json(paymentRequiredPayload)
    const paymentHeader = getPaymentHeader(req)

    if (!paymentHeader) {
      return new Response(JSON.stringify(paymentRequiredPayload), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': paymentRequiredHeader,
        },
      })
    }

    // Ensure the user profile exists before settlement so successful payments can be credited.
    await ctx.runMutation(api.user.ensureCurrentUser, {})

    let paymentPayload: X402PaymentPayload

    try {
      paymentPayload = decodeBase64Json<X402PaymentPayload>(paymentHeader)
    } catch {
      return new Response(JSON.stringify(paymentRequiredPayload), {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': paymentRequiredHeader,
        },
      })
    }

    let verification: X402VerifyResponse

    try {
      verification = await runFacilitatorVerification(
        config,
        paymentPayload,
        requirements,
      )
    } catch (error) {
      return jsonError(
        error instanceof Error
          ? error.message
          : 'Failed to verify x402 payment.',
        502,
      )
    }

    if (!verification.isValid) {
      return new Response(
        JSON.stringify({
          ...paymentRequiredPayload,
          error: verification.invalidReason ?? 'invalid_payment',
        }),
        {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': paymentRequiredHeader,
          },
        },
      )
    }

    let settlement: X402SettleResponse

    try {
      settlement = await runFacilitatorSettlement(config, paymentPayload, requirements)
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : 'Failed to settle x402 payment.',
        502,
      )
    }

    if (!settlement.success || !settlement.transaction) {
      return new Response(
        JSON.stringify({
          ...paymentRequiredPayload,
          error:
            settlement.errorReason ??
            settlement.errorMessage ??
            'x402 settlement was not successful',
        }),
        {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': paymentRequiredHeader,
          },
        },
      )
    }

    const paymentReference = settlement.transaction
    const idempotencyKey = `funding:${paymentReference}`
    const metadataJson = JSON.stringify({
      protocolVersion: X402_PROTOCOL_VERSION,
      payer: settlement.payer ?? verification.payer,
      settlementNetwork: settlement.network ?? requirements.network,
      requirement: requirements,
    })

    const account = await ctx.runMutation(internal.billing.recordFundingTopup, {
      amountUsdCents,
      paymentReference,
      idempotencyKey,
      source: 'x402_settled',
      grossTokenAmount: requirements.amount,
      metadataJson,
    })

    const paymentResponseHeader = encodeBase64Json({
      x402Version: X402_PROTOCOL_VERSION,
      success: true,
      transaction: settlement.transaction,
      network: settlement.network ?? requirements.network,
      payer: settlement.payer ?? verification.payer,
      scheme: requirements.scheme,
    })

    return new Response(
      JSON.stringify({
        account,
        settlement: {
          transaction: settlement.transaction,
          network: settlement.network ?? requirements.network,
          payer: settlement.payer ?? verification.payer,
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-RESPONSE': paymentResponseHeader,
        },
      },
    )
  }),
})

http.route({
  path: '/billing/manual-topup',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = await requireAuthedRequest(ctx)

    if (!auth.ok) {
      return auth.response
    }

    const body = await parseFundingTopupBody(req)

    if (!body) {
      return jsonError('Invalid JSON payload.', 400)
    }

    const amountUsdCents = requireValidTopupAmount(body.amountUsdCents)

    if (
      !amountUsdCents ||
      !body.paymentReference ||
      !body.idempotencyKey ||
      !body.source
    ) {
      return jsonError('Invalid top-up payload.', 400)
    }

    const paymentReference = body.paymentReference as string
    const idempotencyKey = body.idempotencyKey as string
    const source = body.source as FundingTopupSource

    if (source !== 'manual_testnet') {
      return Response.json(
        {
          error:
            'Only manual_testnet top-ups are allowed on this endpoint. Wire x402 settlement to a trusted server callback.',
        },
        { status: 403 },
      )
    }

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

    if (!body.sandboxId || !body.eventType || !body.idempotencyKey) {
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
