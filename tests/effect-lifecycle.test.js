import { describe, expect, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { createSandboxWithPayment } from '../src/features/sandboxes/runtime/lifecycle.ts'
import {
  ConvexService,
  DaytonaService,
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

function createDaytonaLayer(overrides = {}) {
  return Layer.succeed(DaytonaService, {
    createOpenCodeSandbox: () =>
      Effect.succeed({
        daytonaSandboxId: 'daytona_sandbox_123',
        previewUrl: 'https://preview.example',
        workspacePath: '/home/daytona/repo',
      }),
    deleteOpenCodeSandbox: () => Effect.void,
    resolveOpenCodeLaunchConfig: () =>
      Effect.succeed({
        preset: {
          id: 'general-engineer',
        },
        launchEnvironment: {},
      }),
    ensureSandboxAppPreviewServer: () => Effect.die('unused'),
    getSandboxAppPreviewStatus: () => Effect.die('unused'),
    getSandboxAppPreviewLogTail: () => Effect.die('unused'),
    getSandboxAppPreviewCommandSuggestion: () => Effect.die('unused'),
    readSandboxCurrentArtifact: () => Effect.die('unused'),
    createSandboxSshAccessCommand: () => Effect.die('unused'),
    getSandboxPortPreviewUrl: () => Effect.die('unused'),
    sendPromptToSandboxOpencodeSession: () => Effect.die('unused'),
    ...overrides,
  })
}

describe('createSandboxWithPayment', () => {
  test('deletes the Daytona sandbox and marks the record failed when persistence breaks after launch', async () => {
    const deletedSandboxes = []
    const mutationArgs = []
    const layer = Layer.mergeAll(
      createConvexLayer(async (_ref, args) => {
        mutationArgs.push(args)

        if (mutationArgs.length === 1) {
          return { _id: 'sandbox_pending_1' }
        }

        if (mutationArgs.length === 2) {
          throw new Error('mark ready failed')
        }

        return { ok: true }
      }),
      createDaytonaLayer({
        deleteOpenCodeSandbox: (sandboxId) =>
          Effect.sync(() => {
            deletedSandboxes.push(sandboxId)
          }),
      }),
    )

    const program = createSandboxWithPayment(
      {
        repoUrl: 'https://gitlab.com/acme/repo.git',
        branch: 'main',
        agentPresetId: 'general-engineer',
      },
      'credits',
    )

    await expect(
      Effect.runPromise(program.pipe(Effect.provide(layer))),
    ).rejects.toThrow('mark ready failed')
    expect(deletedSandboxes).toEqual(['daytona_sandbox_123'])
    expect(mutationArgs[2]).toEqual({
      sandboxId: 'sandbox_pending_1',
      errorMessage: 'mark ready failed',
    })
  })
})
