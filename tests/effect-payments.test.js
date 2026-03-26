import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { withPaidSandboxAction } from '../src/features/sandboxes/runtime/payments.ts'
import { SandboxError } from '../src/lib/server/effect/errors.ts'
import {
  BillingService,
  ConvexService,
} from '../src/lib/server/effect/services.ts'

function createConvexLayer(mutation) {
  return Layer.succeed(ConvexService, {
    context: {
      convex: {
        mutation,
      },
      convexHttpUrl: 'https://example.site',
      convexUrl: 'https://example.cloud',
      token: 'token',
      userId: 'user_123',
    },
    ensureCurrentUser: Effect.void,
    getOwnedSandbox: () => Effect.die('unused'),
  })
}

const billingLayer = Layer.succeed(BillingService, {
  priceForEvent: () => 0,
  requireDelegatedBudgetAllowance: () => Effect.die('unused'),
  settleDelegatedBudgetOnchain: () => Effect.die('unused'),
})

describe('withPaidSandboxAction', () => {
  test('releases the credit hold when the action fails', async () => {
    const mutations = []
    const layer = Layer.mergeAll(
      createConvexLayer(async (_ref, args) => {
        mutations.push(args)

        if (mutations.length === 1) {
          return { _id: 'hold_1', idempotencyKey: 'hold-key-1' }
        }

        return { ok: true }
      }),
      billingLayer,
    )

    const program = withPaidSandboxAction({
      sandboxId: 'sandbox_1',
      agentPresetId: 'general-engineer',
      eventType: 'ssh_access',
      paymentMethod: 'credits',
      description: 'Generated Daytona SSH access.',
      action: Effect.fail(
        new SandboxError({
          message: 'ssh generation failed',
        }),
      ),
    })

    await expect(
      Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer))),
    ).rejects.toThrow('ssh generation failed')
    expect(mutations).toHaveLength(2)
    expect(mutations[1]).toEqual({
      holdId: 'hold_1',
      reason: 'ssh_access failed before capture.',
    })
  })

  test('releases the hold without capturing when shouldCapture returns false', async () => {
    const mutations = []
    const layer = Layer.mergeAll(
      createConvexLayer(async (_ref, args) => {
        mutations.push(args)

        if (mutations.length === 1) {
          return { _id: 'hold_2', idempotencyKey: 'hold-key-2' }
        }

        return { ok: true }
      }),
      billingLayer,
    )

    const program = withPaidSandboxAction({
      sandboxId: 'sandbox_2',
      agentPresetId: 'general-engineer',
      eventType: 'preview_boot',
      paymentMethod: 'credits',
      description: 'Preview boot on port 3000',
      shouldCapture: (result) => result.status === 'started',
      action: Effect.succeed({
        status: 'already-running',
      }),
    })

    const scopedResult = await Effect.runPromise(
      Effect.scoped(program).pipe(Effect.provide(layer)),
    )

    expect(scopedResult).toEqual({
      status: 'already-running',
    })
    expect(mutations).toHaveLength(2)
    expect(mutations[1]).toEqual({
      holdId: 'hold_2',
      reason: 'No charge captured for preview_boot.',
    })
  })
})
