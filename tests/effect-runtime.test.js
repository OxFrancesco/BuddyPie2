import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { runRouteProgram, runServerProgram } from '../src/lib/server/effect/runtime.ts'

describe('effect runtime boundaries', () => {
  test('runServerProgram provides a scope for acquireRelease programs', async () => {
    let released = false

    const result = await runServerProgram(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(
          Effect.succeed('held'),
          () =>
            Effect.sync(() => {
              released = true
            }),
        )

        return { ok: true }
      }),
      { layer: Layer.empty },
    )

    expect(result).toEqual({ ok: true })
    expect(released).toBe(true)
  })

  test('runRouteProgram provides a scope for acquireRelease programs', async () => {
    let released = false

    const response = await runRouteProgram(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(
          Effect.succeed('held'),
          () =>
            Effect.sync(() => {
              released = true
            }),
        )

        return Response.json({ ok: true })
      }),
      { layer: Layer.empty },
    )

    expect(await response.json()).toEqual({ ok: true })
    expect(released).toBe(true)
  })
})
