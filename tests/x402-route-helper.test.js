import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { executeX402PaymentRoute } from '../src/routes/api/x402/-_helpers.ts'
import { X402Service } from '../src/lib/server/effect/services.ts'

describe('executeX402PaymentRoute', () => {
  test('returns the payment-required response without running the action', async () => {
    let executed = false
    const response = Response.json({ error: 'pay first' }, { status: 402 })
    const layer = Layer.succeed(X402Service, {
      requirePayment: () =>
        Effect.succeed({
          ok: false,
          response,
        }),
      settlePayment: () => Effect.die('unused'),
    })

    const result = await Effect.runPromise(
      executeX402PaymentRoute({
        request: new Request('https://example.com'),
        context: Effect.succeed({ id: 'ctx' }),
        amountUsdCents: () => 123,
        resourceDescription: () => 'Test route',
        execute: () =>
          Effect.sync(() => {
            executed = true
            return { ok: true }
          }),
        recordCharge: () => Effect.void,
      }).pipe(Effect.provide(layer)),
    )

    expect(result.status).toBe(402)
    expect(executed).toBe(false)
  })

  test('skips settlement and charge recording when shouldSettle returns false', async () => {
    let settled = false
    let charged = false
    const layer = Layer.succeed(X402Service, {
      requirePayment: () =>
        Effect.succeed({
          ok: true,
          verification: {},
          settle: async () => {
            settled = true
            return {
              transaction: 'tx_123',
              network: 'base-sepolia',
              payer: '0xabc',
            }
          },
        }),
      settlePayment: (payment) =>
        Effect.tryPromise({
          try: () => payment.settle(),
          catch: (error) => {
            throw error
          },
        }),
    })

    const result = await Effect.runPromise(
      executeX402PaymentRoute({
        request: new Request('https://example.com'),
        context: Effect.succeed({ id: 'ctx' }),
        amountUsdCents: () => 456,
        resourceDescription: () => 'Test route',
        execute: () =>
          Effect.succeed({
            status: 'already-running',
          }),
        shouldSettle: (result) => result.status === 'started',
        recordCharge: () =>
          Effect.sync(() => {
            charged = true
          }),
      }).pipe(Effect.provide(layer)),
    )

    expect(await result.json()).toEqual({
      status: 'already-running',
    })
    expect(settled).toBe(false)
    expect(charged).toBe(false)
  })
})
