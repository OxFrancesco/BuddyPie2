import type { BillingPaymentMethod } from '../../../../convex/lib/billingConfig'
import { Effect } from 'effect'
import {
  ConvexService,
  DaytonaService,
} from '~/lib/server/effect/services'
import { SandboxError } from '~/lib/server/effect/errors'
import { withPaidSandboxAction } from './payments'

function fetchOwnedSandboxOrThrow(sandboxId: string) {
  return Effect.flatMap(ConvexService, (convex) =>
    convex.getOwnedSandbox(sandboxId),
  )
}

export function ensureAppPreviewServerWithPayment(
  sandboxId: string,
  port: number,
  paymentMethod: BillingPaymentMethod,
) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(sandboxId)
    const daytona = yield* DaytonaService

    if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
      return yield* Effect.fail(
        new SandboxError({
          message: 'Sandbox runtime is not ready for app preview yet.',
        }),
      )
    }

    return yield* withPaidSandboxAction({
      sandboxId: sandbox._id,
      agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
      eventType: 'preview_boot',
      paymentMethod,
      quantitySummary: `port:${port}`,
      description: `Preview boot on port ${port}`,
      shouldCapture: (result) => result.status === 'started',
      releaseReason: `Preview server on port ${port} did not need a new boot charge.`,
      action: daytona.ensureSandboxAppPreviewServer({
        daytonaSandboxId: sandbox.daytonaSandboxId,
        workspacePath: sandbox.workspacePath,
        previewAppPath: sandbox.previewAppPath,
        agentPresetId: sandbox.agentPresetId,
        port,
      }),
    })
  })
}

export function getAppPreviewLogsForSandbox(args: {
  sandboxId: string
  port: number
  lines?: number
}) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(args.sandboxId)
    const daytona = yield* DaytonaService

    if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
      return yield* Effect.fail(
        new SandboxError({
          message: 'Sandbox runtime is not ready for log retrieval yet.',
        }),
      )
    }

    return yield* daytona.getSandboxAppPreviewLogTail({
      daytonaSandboxId: sandbox.daytonaSandboxId,
      workspacePath: sandbox.workspacePath,
      previewAppPath: sandbox.previewAppPath,
      agentPresetId: sandbox.agentPresetId,
      port: args.port,
      lines: args.lines,
    })
  })
}

export function getAppPreviewCommandSuggestionForSandbox(args: {
  sandboxId: string
  port: number
}) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(args.sandboxId)
    const daytona = yield* DaytonaService

    if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
      return yield* Effect.fail(
        new SandboxError({
          message:
            'Sandbox runtime is not ready for manual preview guidance yet.',
        }),
      )
    }

    return yield* daytona.getSandboxAppPreviewCommandSuggestion({
      daytonaSandboxId: sandbox.daytonaSandboxId,
      workspacePath: sandbox.workspacePath,
      previewAppPath: sandbox.previewAppPath,
      agentPresetId: sandbox.agentPresetId,
      port: args.port,
    })
  })
}

export function readSandboxArtifactForSandbox(args: {
  sandboxId: string
}) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(args.sandboxId)
    const daytona = yield* DaytonaService

    if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
      return yield* Effect.fail(
        new SandboxError({
          message: 'Sandbox runtime is not ready for artifact retrieval yet.',
        }),
      )
    }

    return yield* daytona.readSandboxCurrentArtifact({
      daytonaSandboxId: sandbox.daytonaSandboxId,
      workspacePath: sandbox.workspacePath,
    })
  })
}

export function createTerminalAccessWithPayment(
  sandboxId: string,
  expiresInMinutes: number | undefined,
  paymentMethod: BillingPaymentMethod,
) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(sandboxId)
    const daytona = yield* DaytonaService

    if (!sandbox.daytonaSandboxId) {
      return yield* Effect.fail(
        new SandboxError({
          message: 'Sandbox runtime is not ready for terminal access yet.',
        }),
      )
    }

    return yield* withPaidSandboxAction({
      sandboxId: sandbox._id,
      agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
      eventType: 'ssh_access',
      paymentMethod,
      quantitySummary: `expires:${expiresInMinutes ?? 60}`,
      description: 'Generated Daytona SSH access.',
      releaseReason: 'SSH access generation failed before capture.',
      action: daytona.createSandboxSshAccessCommand({
        daytonaSandboxId: sandbox.daytonaSandboxId,
        expiresInMinutes,
      }),
    })
  })
}

export function getPortPreviewWithPayment(
  sandboxId: string,
  port: number,
  paymentMethod: BillingPaymentMethod,
) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(sandboxId)
    const daytona = yield* DaytonaService

    if (!sandbox.daytonaSandboxId) {
      return yield* Effect.fail(
        new SandboxError({
          message: 'Sandbox runtime is not ready for preview access yet.',
        }),
      )
    }

    if (port === 22222) {
      return yield* withPaidSandboxAction({
        sandboxId: sandbox._id,
        agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
        eventType: 'web_terminal',
        paymentMethod,
        quantitySummary: `port:${port}`,
        description: 'Opened the Daytona web terminal.',
        releaseReason: 'Web terminal access failed before capture.',
        action: daytona.getSandboxPortPreviewUrl({
          daytonaSandboxId: sandbox.daytonaSandboxId,
          port,
        }),
      })
    }

    return yield* daytona.getSandboxPortPreviewUrl({
      daytonaSandboxId: sandbox.daytonaSandboxId,
      port,
    })
  })
}

export function sendPromptToSandboxAgent(args: {
  sandboxId: string
  prompt: string
}) {
  return Effect.gen(function*() {
    const sandbox = yield* fetchOwnedSandboxOrThrow(args.sandboxId)
    const daytona = yield* DaytonaService

    if (
      !sandbox.daytonaSandboxId ||
      !sandbox.workspacePath ||
      !sandbox.opencodeSessionId
    ) {
      return yield* Effect.fail(
        new SandboxError({
          message: 'Sandbox runtime is not ready for agent prompts yet.',
        }),
      )
    }

    return yield* daytona.sendPromptToSandboxOpencodeSession({
      daytonaSandboxId: sandbox.daytonaSandboxId,
      workspacePath: sandbox.workspacePath,
      agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
      opencodeSessionId: sandbox.opencodeSessionId,
      prompt: args.prompt,
    })
  })
}
