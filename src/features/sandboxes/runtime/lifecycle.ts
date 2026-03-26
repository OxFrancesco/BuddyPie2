import { api } from 'convex/_generated/api'
import type { Doc } from 'convex/_generated/dataModel'
import { Cause, Effect, Exit, Ref } from 'effect'
import type { CreateSandboxInput } from '~/lib/sandboxes'
import {
  ConvexService,
  DaytonaService,
} from '~/lib/server/effect/services'
import {
  ExternalServiceError,
  SandboxError,
  ValidationError,
  toConvexFailureMessage,
} from '~/lib/server/effect/errors'
import {
  getBillingEventPriceUsdCents,
  type BillingPaymentMethod,
} from '../../../../convex/lib/billingConfig'
import {
  getSafeOpenCodeAgentPreset,
  resolveOpenCodeModelOption,
} from '~/lib/opencode/presets'
import { normalizeSandboxInput } from '~/lib/sandboxes'
import { getGithubLaunchAuth } from './github'
import {
  captureDelegatedLaunchCharge,
  requireDelegatedBudgetAllowance,
} from './payments'

type LaunchedSandbox = {
  daytonaSandboxId: string
  previewUrl: string
  previewUrlPattern?: string
  workspacePath: string
  previewAppPath?: string
  opencodeSessionId?: string
}

function normalizeUnknownMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

function sandboxMutation<T>(options: {
  try: () => Promise<T>
  fallback: string
}) {
  return Effect.tryPromise({
    try: options.try,
    catch: (error) =>
      new SandboxError({
        message: normalizeUnknownMessage(error, options.fallback),
        cause: error,
      }),
  })
}

function githubAuthEffect(userId: string) {
  return Effect.tryPromise({
    try: () => getGithubLaunchAuth(userId),
    catch: (error) =>
      new ExternalServiceError({
        service: 'GitHub',
        message: normalizeUnknownMessage(
          error,
          'GitHub could not complete that request.',
        ),
        cause: error,
      }),
  })
}

function resolveSandboxPreset(input: {
  agentPresetId?: string
  agentLabel?: string
  agentProvider?: string
  agentModel?: string
  initialPrompt?: string
}) {
  return Effect.try({
    try: () => {
      const preset = getSafeOpenCodeAgentPreset(input.agentPresetId)
      const modelOption = resolveOpenCodeModelOption({
        provider: input.agentProvider,
        model: input.agentModel,
        fallbackProvider: preset.provider,
        fallbackModel: preset.model,
      })

      return {
        agentPresetId: preset.id,
        agentLabel: input.agentLabel ?? preset.label,
        agentProvider: modelOption.provider,
        agentModel: modelOption.model,
        initialPrompt: input.initialPrompt?.trim() || preset.starterPrompt,
      }
    },
    catch: (error) =>
      new ValidationError({
        message: normalizeUnknownMessage(
          error,
          'The sandbox preset configuration is invalid.',
        ),
        cause: error,
      }),
  })
}

function launchSandboxLifecycle(args: {
  normalized: ReturnType<typeof normalizeSandboxInput>
  paymentMethod: BillingPaymentMethod
}) {
  return Effect.scoped(
    Effect.gen(function*() {
      const convex = yield* ConvexService
      const daytona = yield* DaytonaService
      yield* convex.ensureCurrentUser

      const pendingSandboxRef = yield* Ref.make<Doc<'sandboxes'> | null>(null)
      const launchedSandboxRef = yield* Ref.make<LaunchedSandbox | null>(null)
      const completedRef = yield* Ref.make(false)

      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function*() {
          if (Exit.isSuccess(exit) || (yield* Ref.get(completedRef))) {
            return
          }

          const launched = yield* Ref.get(launchedSandboxRef)

          if (launched?.daytonaSandboxId) {
            yield* daytona.deleteOpenCodeSandbox(launched.daytonaSandboxId).pipe(
              Effect.catchAll(() => Effect.void),
            )
          }

          const pendingSandbox = yield* Ref.get(pendingSandboxRef)

          if (pendingSandbox) {
            yield* sandboxMutation({
              try: () =>
                convex.context.convex.mutation(api.sandboxes.markFailed, {
                  sandboxId: pendingSandbox._id,
                  errorMessage: toConvexFailureMessage(Cause.squash(exit.cause)),
                }),
              fallback: 'BuddyPie could not persist the sandbox failure state.',
            }).pipe(Effect.catchAll(() => Effect.void))
          }
        }),
      )

      if (args.paymentMethod === 'delegated_budget') {
        yield* requireDelegatedBudgetAllowance({
          requiredAmountUsdCents: getBillingEventPriceUsdCents(
            args.normalized.agentPresetId,
            'sandbox_launch',
          ),
          actionLabel: `launching ${args.normalized.repoName}`,
        })
      }

      const githubAuth =
        args.normalized.repoProvider === 'github'
          ? yield* githubAuthEffect(convex.context.userId)
          : null

      yield* daytona.resolveOpenCodeLaunchConfig({
        agentPresetId: args.normalized.agentPresetId,
        agentProvider: args.normalized.agentProvider,
        agentModel: args.normalized.agentModel,
        githubAuth,
      })

      const pendingSandbox = yield* sandboxMutation({
        try: () =>
          convex.context.convex.mutation(api.sandboxes.createPending, {
            repoName: args.normalized.repoName,
            agentPresetId: args.normalized.agentPresetId,
            agentLabel: args.normalized.agentLabel,
            agentProvider: args.normalized.agentProvider,
            agentModel: args.normalized.agentModel,
            initialPrompt: args.normalized.initialPrompt,
            paymentMethod: args.paymentMethod,
            ...(args.normalized.repoUrl
              ? { repoUrl: args.normalized.repoUrl }
              : {}),
            ...(args.normalized.branch
              ? { repoBranch: args.normalized.branch }
              : {}),
            ...(args.normalized.repoProvider
              ? { repoProvider: args.normalized.repoProvider }
              : {}),
          }),
        fallback: 'BuddyPie could not create the pending sandbox record.',
      })
      yield* Ref.set(pendingSandboxRef, pendingSandbox)

      const launched = yield* daytona.createOpenCodeSandbox({
        repoUrl: args.normalized.repoUrl,
        branch: args.normalized.branch,
        agentPresetId: args.normalized.agentPresetId,
        agentProvider: args.normalized.agentProvider,
        agentModel: args.normalized.agentModel,
        initialPrompt: args.normalized.initialPrompt,
        githubAuth,
      })
      yield* Ref.set(launchedSandboxRef, launched)

      if (args.paymentMethod === 'delegated_budget') {
        yield* captureDelegatedLaunchCharge({
          sandboxId: pendingSandbox._id,
          agentPresetId: args.normalized.agentPresetId,
          repoName: args.normalized.repoName,
          repoBranch: args.normalized.branch,
        })
      }

      const readySandbox = yield* sandboxMutation({
        try: () =>
          convex.context.convex.mutation(api.sandboxes.markReady, {
            sandboxId: pendingSandbox._id,
            daytonaSandboxId: launched.daytonaSandboxId,
            previewUrl: launched.previewUrl,
            previewUrlPattern: launched.previewUrlPattern,
            workspacePath: launched.workspacePath,
            previewAppPath: launched.previewAppPath,
            opencodeSessionId: launched.opencodeSessionId,
          }),
        fallback: 'BuddyPie could not persist the launched sandbox.',
      })

      yield* Ref.set(completedRef, true)

      return {
        sandboxId: readySandbox._id,
        previewUrl: readySandbox.previewUrl ?? launched.previewUrl,
        agentPresetId:
          readySandbox.agentPresetId ?? args.normalized.agentPresetId,
      }
    }),
  )
}

function restartSandboxLifecycle(args: {
  sandboxId: string
  paymentMethod: BillingPaymentMethod
}) {
  return Effect.scoped(
    Effect.gen(function*() {
      const convex = yield* ConvexService
      const daytona = yield* DaytonaService
      const sandbox = yield* convex.getOwnedSandbox(args.sandboxId)
      const restartPreset = yield* resolveSandboxPreset(sandbox)

      const pendingSandboxRef = yield* Ref.make<Doc<'sandboxes'> | null>(null)
      const launchedSandboxRef = yield* Ref.make<LaunchedSandbox | null>(null)
      const completedRef = yield* Ref.make(false)

      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function*() {
          if (Exit.isSuccess(exit) || (yield* Ref.get(completedRef))) {
            return
          }

          const launched = yield* Ref.get(launchedSandboxRef)

          if (launched?.daytonaSandboxId) {
            yield* daytona.deleteOpenCodeSandbox(launched.daytonaSandboxId).pipe(
              Effect.catchAll(() => Effect.void),
            )
          }

          const pendingSandbox = yield* Ref.get(pendingSandboxRef)

          if (pendingSandbox) {
            yield* sandboxMutation({
              try: () =>
                convex.context.convex.mutation(api.sandboxes.markFailed, {
                  sandboxId: pendingSandbox._id,
                  errorMessage: toConvexFailureMessage(Cause.squash(exit.cause)),
                }),
              fallback: 'BuddyPie could not persist the sandbox failure state.',
            }).pipe(Effect.catchAll(() => Effect.void))
          }
        }),
      )

      if (args.paymentMethod === 'delegated_budget') {
        yield* requireDelegatedBudgetAllowance({
          requiredAmountUsdCents: getBillingEventPriceUsdCents(
            restartPreset.agentPresetId,
            'sandbox_launch',
          ),
          actionLabel: `restarting ${sandbox.repoName}`,
        })
      }

      const githubAuth =
        sandbox.repoProvider === 'github'
          ? yield* githubAuthEffect(convex.context.userId)
          : null

      yield* daytona.resolveOpenCodeLaunchConfig({
        agentPresetId: restartPreset.agentPresetId,
        agentProvider: restartPreset.agentProvider,
        agentModel: restartPreset.agentModel,
        githubAuth,
      })

      const pendingSandbox = yield* sandboxMutation({
        try: () =>
          convex.context.convex.mutation(api.sandboxes.createPending, {
            repoName: sandbox.repoName,
            agentPresetId: restartPreset.agentPresetId,
            agentLabel: restartPreset.agentLabel,
            agentProvider: restartPreset.agentProvider,
            agentModel: restartPreset.agentModel,
            initialPrompt: restartPreset.initialPrompt,
            paymentMethod: args.paymentMethod,
            ...(sandbox.repoUrl ? { repoUrl: sandbox.repoUrl } : {}),
            ...(sandbox.repoBranch ? { repoBranch: sandbox.repoBranch } : {}),
            ...(sandbox.repoProvider
              ? { repoProvider: sandbox.repoProvider }
              : {}),
          }),
        fallback: 'BuddyPie could not create the replacement sandbox record.',
      })
      yield* Ref.set(pendingSandboxRef, pendingSandbox)

      const launched = yield* daytona.createOpenCodeSandbox({
        repoUrl: sandbox.repoUrl,
        branch: sandbox.repoBranch,
        agentPresetId: restartPreset.agentPresetId,
        agentProvider: restartPreset.agentProvider,
        agentModel: restartPreset.agentModel,
        initialPrompt: restartPreset.initialPrompt,
        githubAuth,
      })
      yield* Ref.set(launchedSandboxRef, launched)

      if (args.paymentMethod === 'delegated_budget') {
        yield* captureDelegatedLaunchCharge({
          sandboxId: pendingSandbox._id,
          agentPresetId: restartPreset.agentPresetId,
          repoName: sandbox.repoName,
          repoBranch: sandbox.repoBranch,
        })
      }

      const readySandbox = yield* sandboxMutation({
        try: () =>
          convex.context.convex.mutation(api.sandboxes.markReady, {
            sandboxId: pendingSandbox._id,
            daytonaSandboxId: launched.daytonaSandboxId,
            previewUrl: launched.previewUrl,
            previewUrlPattern: launched.previewUrlPattern,
            workspacePath: launched.workspacePath,
            previewAppPath: launched.previewAppPath,
            opencodeSessionId: launched.opencodeSessionId,
          }),
        fallback: 'BuddyPie could not persist the replacement sandbox.',
      })

      if (sandbox.daytonaSandboxId) {
        yield* daytona.deleteOpenCodeSandbox(sandbox.daytonaSandboxId).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }

      yield* sandboxMutation({
        try: () =>
          convex.context.convex.mutation(api.sandboxes.remove, {
            sandboxId: sandbox._id,
          }),
        fallback: 'BuddyPie could not remove the previous sandbox record.',
      })

      yield* Ref.set(completedRef, true)

      return {
        sandboxId: readySandbox._id,
        previewUrl: readySandbox.previewUrl ?? launched.previewUrl,
        agentPresetId: readySandbox.agentPresetId ?? restartPreset.agentPresetId,
      }
    }),
  )
}

export function createSandboxWithPayment(
  input: CreateSandboxInput,
  paymentMethod: BillingPaymentMethod,
) {
  return Effect.try({
    try: () => normalizeSandboxInput(input),
    catch: (error) =>
      new ValidationError({
        message: normalizeUnknownMessage(error, 'Sandbox input is invalid.'),
        cause: error,
      }),
  }).pipe(
    Effect.flatMap((normalized) =>
      launchSandboxLifecycle({
        normalized,
        paymentMethod,
      }),
    ),
  )
}

export function deleteSandboxRuntime(sandboxId: string) {
  return Effect.gen(function*() {
    const convex = yield* ConvexService
    const daytona = yield* DaytonaService
    const sandbox = yield* convex.getOwnedSandbox(sandboxId)

    if (sandbox.daytonaSandboxId) {
      yield* daytona.deleteOpenCodeSandbox(sandbox.daytonaSandboxId).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }

    yield* sandboxMutation({
      try: () =>
        convex.context.convex.mutation(api.sandboxes.remove, {
          sandboxId: sandbox._id,
        }),
      fallback: 'BuddyPie could not remove the sandbox record.',
    })

    return { removed: true as const }
  })
}

export function restartSandboxWithPayment(
  sandboxId: string,
  paymentMethod: BillingPaymentMethod,
) {
  return restartSandboxLifecycle({
    sandboxId,
    paymentMethod,
  })
}
