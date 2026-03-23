import { api } from 'convex/_generated/api'
import type { Doc, Id } from 'convex/_generated/dataModel'
import {
  getBillingEventPriceUsdCents,
  type BillingPaymentMethod,
} from '../../../../convex/lib/billingConfig'
import type { CreateSandboxInput } from '~/lib/sandboxes'
import {
  getSafeOpenCodeAgentPreset,
  resolveOpenCodeModelOption,
} from '~/lib/opencode/presets'
import { normalizeSandboxInput } from '~/lib/sandboxes'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'
import {
  createOpenCodeSandbox,
  deleteOpenCodeSandbox,
  resolveOpenCodeLaunchConfig,
} from '~/lib/server/daytona'
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Something went wrong while talking to Daytona.'
}

function resolveSandboxPreset(input: {
  agentPresetId?: string
  agentLabel?: string
  agentProvider?: string
  agentModel?: string
  initialPrompt?: string
}) {
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
}

async function launchSandboxLifecycle(args: {
  normalized: ReturnType<typeof normalizeSandboxInput>
  paymentMethod: BillingPaymentMethod
}) {
  const { convex, userId } = await getAuthenticatedConvexClient()
  await convex.mutation(api.user.ensureCurrentUser, {})
  let pendingSandbox: Doc<'sandboxes'> | null = null
  let launched: LaunchedSandbox | null = null

  try {
    if (args.paymentMethod === 'delegated_budget') {
      await requireDelegatedBudgetAllowance({
        requiredAmountUsdCents: getBillingEventPriceUsdCents(
          args.normalized.agentPresetId,
          'sandbox_launch',
        ),
        actionLabel: `launching ${args.normalized.repoName}`,
      })
    }

    const githubAuth =
      args.normalized.repoProvider === 'github'
        ? await getGithubLaunchAuth(userId)
        : null
    resolveOpenCodeLaunchConfig({
      agentPresetId: args.normalized.agentPresetId,
      agentProvider: args.normalized.agentProvider,
      agentModel: args.normalized.agentModel,
      githubAuth,
    })
    pendingSandbox = await convex.mutation(api.sandboxes.createPending, {
      repoName: args.normalized.repoName,
      agentPresetId: args.normalized.agentPresetId,
      agentLabel: args.normalized.agentLabel,
      agentProvider: args.normalized.agentProvider,
      agentModel: args.normalized.agentModel,
      initialPrompt: args.normalized.initialPrompt,
      paymentMethod: args.paymentMethod,
      ...(args.normalized.repoUrl ? { repoUrl: args.normalized.repoUrl } : {}),
      ...(args.normalized.branch ? { repoBranch: args.normalized.branch } : {}),
      ...(args.normalized.repoProvider
        ? { repoProvider: args.normalized.repoProvider }
        : {}),
    })
    launched = await createOpenCodeSandbox({
      repoUrl: args.normalized.repoUrl,
      branch: args.normalized.branch,
      agentPresetId: args.normalized.agentPresetId,
      agentProvider: args.normalized.agentProvider,
      agentModel: args.normalized.agentModel,
      initialPrompt: args.normalized.initialPrompt,
      githubAuth,
    })

    if (args.paymentMethod === 'delegated_budget') {
      await captureDelegatedLaunchCharge({
        sandboxId: pendingSandbox._id,
        agentPresetId: args.normalized.agentPresetId,
        repoName: args.normalized.repoName,
        repoBranch: args.normalized.branch,
      })
    }

    const readySandbox = await convex.mutation(api.sandboxes.markReady, {
      sandboxId: pendingSandbox._id,
      daytonaSandboxId: launched.daytonaSandboxId,
      previewUrl: launched.previewUrl,
      previewUrlPattern: launched.previewUrlPattern,
      workspacePath: launched.workspacePath,
      previewAppPath: launched.previewAppPath,
      opencodeSessionId: launched.opencodeSessionId,
    })

    return {
      sandboxId: readySandbox._id,
      previewUrl: readySandbox.previewUrl ?? launched.previewUrl,
      agentPresetId:
        readySandbox.agentPresetId ?? args.normalized.agentPresetId,
    }
  } catch (error) {
    const message = getErrorMessage(error)

    if (launched?.daytonaSandboxId) {
      try {
        await deleteOpenCodeSandbox(launched.daytonaSandboxId)
      } catch {
        // Best effort cleanup if the post-launch persistence step fails.
      }
    }

    if (pendingSandbox) {
      await convex.mutation(api.sandboxes.markFailed, {
        sandboxId: pendingSandbox._id,
        errorMessage: message,
      })
    }

    throw new Error(message)
  }
}

async function restartSandboxLifecycle(args: {
  sandboxId: string
  paymentMethod: BillingPaymentMethod
}) {
  const { convex, userId } = await getAuthenticatedConvexClient()
  const sandbox = await convex.query(api.sandboxes.get, {
    sandboxId: args.sandboxId as Id<'sandboxes'>,
  })

  if (!sandbox) {
    throw new Error('Sandbox not found.')
  }

  const restartPreset = resolveSandboxPreset(sandbox)
  let pendingSandbox: Doc<'sandboxes'> | null = null
  let launched: LaunchedSandbox | null = null

  try {
    if (args.paymentMethod === 'delegated_budget') {
      await requireDelegatedBudgetAllowance({
        requiredAmountUsdCents: getBillingEventPriceUsdCents(
          restartPreset.agentPresetId,
          'sandbox_launch',
        ),
        actionLabel: `restarting ${sandbox.repoName}`,
      })
    }

    const githubAuth =
      sandbox.repoProvider === 'github'
        ? await getGithubLaunchAuth(userId)
        : null
    resolveOpenCodeLaunchConfig({
      agentPresetId: restartPreset.agentPresetId,
      agentProvider: restartPreset.agentProvider,
      agentModel: restartPreset.agentModel,
      githubAuth,
    })
    pendingSandbox = await convex.mutation(api.sandboxes.createPending, {
      repoName: sandbox.repoName,
      agentPresetId: restartPreset.agentPresetId,
      agentLabel: restartPreset.agentLabel,
      agentProvider: restartPreset.agentProvider,
      agentModel: restartPreset.agentModel,
      initialPrompt: restartPreset.initialPrompt,
      paymentMethod: args.paymentMethod,
      ...(sandbox.repoUrl ? { repoUrl: sandbox.repoUrl } : {}),
      ...(sandbox.repoBranch ? { repoBranch: sandbox.repoBranch } : {}),
      ...(sandbox.repoProvider ? { repoProvider: sandbox.repoProvider } : {}),
    })
    launched = await createOpenCodeSandbox({
      repoUrl: sandbox.repoUrl,
      branch: sandbox.repoBranch,
      agentPresetId: restartPreset.agentPresetId,
      agentProvider: restartPreset.agentProvider,
      agentModel: restartPreset.agentModel,
      initialPrompt: restartPreset.initialPrompt,
      githubAuth,
    })

    if (args.paymentMethod === 'delegated_budget') {
      await captureDelegatedLaunchCharge({
        sandboxId: pendingSandbox._id,
        agentPresetId: restartPreset.agentPresetId,
        repoName: sandbox.repoName,
        repoBranch: sandbox.repoBranch,
      })
    }

    const readySandbox = await convex.mutation(api.sandboxes.markReady, {
      sandboxId: pendingSandbox._id,
      daytonaSandboxId: launched.daytonaSandboxId,
      previewUrl: launched.previewUrl,
      previewUrlPattern: launched.previewUrlPattern,
      workspacePath: launched.workspacePath,
      previewAppPath: launched.previewAppPath,
      opencodeSessionId: launched.opencodeSessionId,
    })

    if (sandbox.daytonaSandboxId) {
      try {
        await deleteOpenCodeSandbox(sandbox.daytonaSandboxId)
      } catch {
        // Keep the new sandbox even if deleting the old runtime fails.
      }
    }

    await convex.mutation(api.sandboxes.remove, {
      sandboxId: sandbox._id,
    })

    return {
      sandboxId: readySandbox._id,
      previewUrl: readySandbox.previewUrl ?? launched.previewUrl,
      agentPresetId: readySandbox.agentPresetId ?? restartPreset.agentPresetId,
    }
  } catch (error) {
    const message = getErrorMessage(error)

    if (launched?.daytonaSandboxId) {
      try {
        await deleteOpenCodeSandbox(launched.daytonaSandboxId)
      } catch {
        // Best effort cleanup if the post-launch persistence step fails.
      }
    }

    if (pendingSandbox) {
      await convex.mutation(api.sandboxes.markFailed, {
        sandboxId: pendingSandbox._id,
        errorMessage: message,
      })
    }

    throw new Error(message)
  }
}

export async function createSandboxWithPayment(
  input: CreateSandboxInput,
  paymentMethod: BillingPaymentMethod,
) {
  const normalized = normalizeSandboxInput(input)

  return await launchSandboxLifecycle({
    normalized,
    paymentMethod,
  })
}

export async function deleteSandboxRuntime(sandboxId: string) {
  const { convex } = await getAuthenticatedConvexClient()
  const sandbox = await convex.query(api.sandboxes.get, {
    sandboxId: sandboxId as Id<'sandboxes'>,
  })

  if (!sandbox) {
    throw new Error('Sandbox not found.')
  }

  if (sandbox.daytonaSandboxId) {
    try {
      await deleteOpenCodeSandbox(sandbox.daytonaSandboxId)
    } catch {
      // Best effort cleanup so stale Daytona sandboxes do not block record deletion.
    }
  }

  await convex.mutation(api.sandboxes.remove, {
    sandboxId: sandbox._id,
  })

  return { removed: true as const }
}

export async function restartSandboxWithPayment(
  sandboxId: string,
  paymentMethod: BillingPaymentMethod,
) {
  return await restartSandboxLifecycle({
    sandboxId,
    paymentMethod,
  })
}
