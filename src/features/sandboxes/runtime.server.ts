import { randomUUID } from 'node:crypto'
import { api } from 'convex/_generated/api'
import type { Doc, Id } from 'convex/_generated/dataModel'
import {
  getBillingEventPriceUsdCents,
  type BillingPaymentMethod,
} from '../../../convex/lib/billingConfig'
import type { CreateSandboxInput } from '~/lib/sandboxes'
import {
  getSafeOpenCodeAgentPreset,
  resolveOpenCodeModelOption,
} from '~/lib/opencode/presets'
import { normalizeSandboxInput } from '~/lib/sandboxes'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'
import {
  assertDelegatedBudgetAllowanceOrThrow,
  settleDelegatedBudgetOnchain,
} from '~/lib/server/delegated-budget'

type GithubApiRepo = {
  id: number
  full_name: string
  clone_url: string
  default_branch: string
  private: boolean
}

type GithubApiBranch = {
  name: string
}

type LaunchedSandbox = {
  daytonaSandboxId: string
  previewUrl: string
  previewUrlPattern?: string
  workspacePath: string
  opencodeSessionId?: string
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Something went wrong while talking to Daytona.'
}

async function requireDelegatedBudgetAllowance(args: {
  requiredAmountUsdCents: number
  actionLabel: string
}): Promise<Doc<'delegatedBudgets'>> {
  const { convex } = await getAuthenticatedConvexClient()
  const delegatedBudget = await convex.query(api.billing.currentDelegatedBudget, {})

  if (!delegatedBudget) {
    throw new Error(
      'Set up an active delegated budget before using that payment rail.',
    )
  }

  await assertDelegatedBudgetAllowanceOrThrow({
    budget: delegatedBudget,
    requiredAmountUsdCents: args.requiredAmountUsdCents,
    actionLabel: args.actionLabel,
  })

  return delegatedBudget
}

async function getGithubAccessToken(userId: string) {
  const { clerkClient } = await import('@clerk/tanstack-react-start/server')
  const client = await clerkClient()
  const tokens = await client.users.getUserOauthAccessToken(userId, 'github')
  return tokens.data[0]?.token ?? null
}

async function getRequiredGithubAccessToken(userId: string) {
  const githubToken = await getGithubAccessToken(userId)

  if (!githubToken) {
    throw new Error('Connect GitHub in Clerk before fetching repositories.')
  }

  return githubToken
}

async function githubRequest<T>(githubToken: string, path: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (response.ok) {
    return (await response.json()) as T
  }

  let githubMessage = 'GitHub could not complete that request.'

  try {
    const error = (await response.json()) as { message?: string }

    if (error.message) {
      githubMessage = error.message
    }
  } catch {
    // Fall back to the generic message when GitHub returns a non-JSON body.
  }

  if (response.status === 401) {
    throw new Error(
      'Your GitHub access expired. Refresh the GitHub connection in Clerk and try again.',
    )
  }

  if (response.status === 403) {
    throw new Error(
      'GitHub denied access. Refresh the GitHub connection in Clerk and make sure repo access is granted.',
    )
  }

  throw new Error(githubMessage)
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

async function withPaidSandboxAction<T>(args: {
  sandboxId: Id<'sandboxes'>
  agentPresetId: string
  eventType: 'preview_boot' | 'ssh_access' | 'web_terminal'
  paymentMethod: BillingPaymentMethod
  quantitySummary?: string
  description: string
  action: () => Promise<T>
  shouldCapture?: (result: T) => boolean
  releaseReason?: string
}) {
  const { convex } = await getAuthenticatedConvexClient()
  const amountUsdCents = getBillingEventPriceUsdCents(
    args.agentPresetId,
    args.eventType,
  )

  if (args.paymentMethod === 'x402') {
    return await args.action()
  }

  if (args.paymentMethod === 'delegated_budget') {
    let delegatedBudget: Awaited<
      ReturnType<typeof requireDelegatedBudgetAllowance>
    > | null = null
    if (!args.shouldCapture) {
      delegatedBudget = await requireDelegatedBudgetAllowance({
        requiredAmountUsdCents: amountUsdCents,
        actionLabel: args.description,
      })
    }

    const result = await args.action()

    if (args.shouldCapture && !args.shouldCapture(result)) {
      return result
    }

    delegatedBudget ??= await requireDelegatedBudgetAllowance({
      requiredAmountUsdCents: amountUsdCents,
      actionLabel: args.description,
    })

    const idempotencyKey = `${args.eventType}:${args.sandboxId}:${randomUUID()}`
    const settlement = await settleDelegatedBudgetOnchain({
      budget: delegatedBudget,
      amountUsdCents,
      idempotencyKey,
    })

    await convex.mutation(api.billing.recordDelegatedBudgetCharge, {
      delegatedBudgetId: delegatedBudget._id,
      sandboxId: args.sandboxId,
      agentPresetId: args.agentPresetId,
      eventType: args.eventType,
      amountUsdCents,
      idempotencyKey,
      description: args.description,
      quantitySummary: args.quantitySummary,
      settlementId: settlement.settlementId,
      txHash: settlement.txHash,
      remainingAmountUsdCents: settlement.budget.remainingAmountUsdCents,
      ...(settlement.budget.periodStartedAt
        ? { periodStartedAt: settlement.budget.periodStartedAt }
        : {}),
      ...(settlement.budget.periodEndsAt
        ? { periodEndsAt: settlement.budget.periodEndsAt }
        : {}),
      ...(settlement.budget.lastSettlementAt
        ? { settledAt: settlement.budget.lastSettlementAt }
        : {}),
      metadataJson: JSON.stringify({
        contractBudgetId: delegatedBudget.contractBudgetId,
      }),
    })

    return result
  }

  const hold = await convex.mutation(api.billing.holdCredits, {
    sandboxId: args.sandboxId,
    agentPresetId: args.agentPresetId,
    purpose: args.eventType,
    amountUsdCents: getBillingEventPriceUsdCents(
      args.agentPresetId,
      args.eventType,
    ),
    idempotencyKey: `${args.eventType}:${args.sandboxId}:${Date.now()}`,
    quantitySummary: args.quantitySummary,
    description: args.description,
  })

  try {
    const result = await args.action()

    if (args.shouldCapture && !args.shouldCapture(result)) {
      await convex.mutation(api.billing.releaseCreditHold, {
        holdId: hold._id,
        reason:
          args.releaseReason ?? `No charge captured for ${args.eventType}.`,
      })

      return result
    }

    await convex.mutation(api.billing.captureCreditHold, {
      holdId: hold._id,
      sandboxId: args.sandboxId,
      eventType: args.eventType,
      idempotencyKey: `capture:${hold.idempotencyKey}`,
      description: args.description,
      quantitySummary: args.quantitySummary,
      costUsdCents: getBillingEventPriceUsdCents(
        args.agentPresetId,
        args.eventType,
      ),
    })

    return result
  } catch (error) {
    try {
      await convex.mutation(api.billing.releaseCreditHold, {
        holdId: hold._id,
        reason:
          args.releaseReason ?? `${args.eventType} failed before capture.`,
      })
    } catch {
      // Best effort cleanup if the action throws after the hold is created.
    }

    throw error
  }
}

async function captureDelegatedLaunchCharge(args: {
  sandboxId: Id<'sandboxes'>
  agentPresetId: string
  repoName: string
  repoBranch?: string
}) {
  const amountUsdCents = getBillingEventPriceUsdCents(
    args.agentPresetId,
    'sandbox_launch',
  )
  const delegatedBudget = await requireDelegatedBudgetAllowance({
    requiredAmountUsdCents: amountUsdCents,
    actionLabel: `launching OpenCode for ${args.repoName}`,
  })
  const { convex } = await getAuthenticatedConvexClient()
  const idempotencyKey = `sandbox_launch:${args.sandboxId}:${randomUUID()}`
  const settlement = await settleDelegatedBudgetOnchain({
    budget: delegatedBudget,
    amountUsdCents,
    idempotencyKey,
  })

  await convex.mutation(api.billing.recordDelegatedBudgetCharge, {
    delegatedBudgetId: delegatedBudget._id,
    sandboxId: args.sandboxId,
    agentPresetId: args.agentPresetId,
    eventType: 'sandbox_launch',
    amountUsdCents,
    idempotencyKey,
    description: `OpenCode sandbox launch for ${args.repoName}`,
    quantitySummary: args.repoBranch ?? 'default branch',
    settlementId: settlement.settlementId,
    txHash: settlement.txHash,
    remainingAmountUsdCents: settlement.budget.remainingAmountUsdCents,
    ...(settlement.budget.periodStartedAt
      ? { periodStartedAt: settlement.budget.periodStartedAt }
      : {}),
    ...(settlement.budget.periodEndsAt
      ? { periodEndsAt: settlement.budget.periodEndsAt }
      : {}),
    ...(settlement.budget.lastSettlementAt
      ? { settledAt: settlement.budget.lastSettlementAt }
      : {}),
    metadataJson: JSON.stringify({
      contractBudgetId: delegatedBudget.contractBudgetId,
    }),
  })
}

async function fetchOwnedSandboxOrThrow(sandboxId: string) {
  const { convex } = await getAuthenticatedConvexClient()
  const sandbox = await convex.query(api.sandboxes.get, {
    sandboxId: sandboxId as Id<'sandboxes'>,
  })

  if (!sandbox) {
    throw new Error('Sandbox not found.')
  }

  return sandbox
}

async function launchSandboxLifecycle(args: {
  normalized: ReturnType<typeof normalizeSandboxInput>
  paymentMethod: BillingPaymentMethod
}) {
  const { convex, userId } = await getAuthenticatedConvexClient()
  await convex.mutation(api.user.ensureCurrentUser, {})

  const pendingSandbox = await convex.mutation(api.sandboxes.createPending, {
    repoUrl: args.normalized.repoUrl,
    repoName: args.normalized.repoName,
    repoBranch: args.normalized.branch,
    repoProvider: args.normalized.repoProvider,
    agentPresetId: args.normalized.agentPresetId,
    agentLabel: args.normalized.agentLabel,
    agentProvider: args.normalized.agentProvider,
    agentModel: args.normalized.agentModel,
    initialPrompt: args.normalized.initialPrompt,
    paymentMethod: args.paymentMethod,
  })
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

    const githubToken =
      args.normalized.repoProvider === 'github'
        ? await getGithubAccessToken(userId)
        : null
    const { createOpenCodeSandbox } = await import('~/lib/server/daytona')
    launched = await createOpenCodeSandbox({
      repoUrl: args.normalized.repoUrl,
      branch: args.normalized.branch,
      agentPresetId: args.normalized.agentPresetId,
      agentProvider: args.normalized.agentProvider,
      agentModel: args.normalized.agentModel,
      initialPrompt: args.normalized.initialPrompt,
      githubToken,
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
        const { deleteOpenCodeSandbox } = await import('~/lib/server/daytona')
        await deleteOpenCodeSandbox(launched.daytonaSandboxId)
      } catch {
        // Best effort cleanup if the post-launch persistence step fails.
      }
    }

    await convex.mutation(api.sandboxes.markFailed, {
      sandboxId: pendingSandbox._id,
      errorMessage: message,
    })

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
  const pendingSandbox = await convex.mutation(api.sandboxes.createPending, {
    repoUrl: sandbox.repoUrl,
    repoName: sandbox.repoName,
    repoBranch: sandbox.repoBranch,
    repoProvider: sandbox.repoProvider,
    agentPresetId: restartPreset.agentPresetId,
    agentLabel: restartPreset.agentLabel,
    agentProvider: restartPreset.agentProvider,
    agentModel: restartPreset.agentModel,
    initialPrompt: restartPreset.initialPrompt,
    paymentMethod: args.paymentMethod,
  })
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

    const githubToken =
      sandbox.repoProvider === 'github'
        ? await getGithubAccessToken(userId)
        : null
    const { createOpenCodeSandbox, deleteOpenCodeSandbox } =
      await import('~/lib/server/daytona')
    launched = await createOpenCodeSandbox({
      repoUrl: sandbox.repoUrl,
      branch: sandbox.repoBranch,
      agentPresetId: restartPreset.agentPresetId,
      agentProvider: restartPreset.agentProvider,
      agentModel: restartPreset.agentModel,
      initialPrompt: restartPreset.initialPrompt,
      githubToken,
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
        const { deleteOpenCodeSandbox } = await import('~/lib/server/daytona')
        await deleteOpenCodeSandbox(launched.daytonaSandboxId)
      } catch {
        // Best effort cleanup if the post-launch persistence step fails.
      }
    }

    await convex.mutation(api.sandboxes.markFailed, {
      sandboxId: pendingSandbox._id,
      errorMessage: message,
    })

    throw new Error(message)
  }
}

async function fetchGithubRepos(githubToken: string) {
  return githubRequest<Array<GithubApiRepo>>(
    githubToken,
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=10',
  )
}

export async function checkGithubConnectionRuntime() {
  const { userId } = await getAuthenticatedConvexClient()
  const githubToken = await getGithubAccessToken(userId)

  return {
    connected: Boolean(githubToken),
    message: githubToken
      ? 'GitHub is connected and ready for private repository imports.'
      : 'Connect GitHub from your Clerk profile to import private repositories.',
  }
}

export async function listGithubReposRuntime() {
  const { userId } = await getAuthenticatedConvexClient()
  const githubToken = await getRequiredGithubAccessToken(userId)
  const repos = await fetchGithubRepos(githubToken)

  return repos.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    private: repo.private,
  }))
}

export async function listGithubBranchesRuntime(repoFullName: string) {
  const normalizedRepoFullName = repoFullName.trim()
  const [owner, repo, ...rest] = normalizedRepoFullName.split('/')

  if (!owner || !repo || rest.length > 0) {
    throw new Error('Choose a valid GitHub repository before fetching branches.')
  }

  const { userId } = await getAuthenticatedConvexClient()
  const githubToken = await getRequiredGithubAccessToken(userId)
  const branches = await githubRequest<Array<GithubApiBranch>>(
    githubToken,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
  )

  return branches.map((branch) => branch.name)
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
      const { deleteOpenCodeSandbox } = await import('~/lib/server/daytona')
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

export async function ensureAppPreviewServerWithPayment(
  sandboxId: string,
  port: number,
  paymentMethod: BillingPaymentMethod,
) {
  const sandbox = await fetchOwnedSandboxOrThrow(sandboxId)

  if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
    throw new Error('Sandbox runtime is not ready for app preview yet.')
  }

  const { ensureSandboxAppPreviewServer } = await import('~/lib/server/daytona')

  return await withPaidSandboxAction({
    sandboxId: sandbox._id,
    agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
    eventType: 'preview_boot',
    paymentMethod,
    quantitySummary: `port:${port}`,
    description: `Preview boot on port ${port}`,
    shouldCapture: (result) => result.status === 'started',
    releaseReason: `Preview server on port ${port} did not need a new boot charge.`,
    action: async () =>
      await ensureSandboxAppPreviewServer({
        daytonaSandboxId: sandbox.daytonaSandboxId!,
        workspacePath: sandbox.workspacePath!,
        port,
      }),
  })
}

export async function getAppPreviewLogsForSandbox(args: {
  sandboxId: string
  port: number
  lines?: number
}) {
  const sandbox = await fetchOwnedSandboxOrThrow(args.sandboxId)

  if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
    throw new Error('Sandbox runtime is not ready for log retrieval yet.')
  }

  const { getSandboxAppPreviewLogTail } = await import('~/lib/server/daytona')

  return await getSandboxAppPreviewLogTail({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    workspacePath: sandbox.workspacePath,
    port: args.port,
    lines: args.lines,
  })
}

export async function getAppPreviewCommandSuggestionForSandbox(args: {
  sandboxId: string
  port: number
}) {
  const sandbox = await fetchOwnedSandboxOrThrow(args.sandboxId)

  if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
    throw new Error(
      'Sandbox runtime is not ready for manual preview guidance yet.',
    )
  }

  const { getSandboxAppPreviewCommandSuggestion } =
    await import('~/lib/server/daytona')

  return await getSandboxAppPreviewCommandSuggestion({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    workspacePath: sandbox.workspacePath,
    port: args.port,
  })
}

export async function createTerminalAccessWithPayment(
  sandboxId: string,
  expiresInMinutes: number | undefined,
  paymentMethod: BillingPaymentMethod,
) {
  const sandbox = await fetchOwnedSandboxOrThrow(sandboxId)

  if (!sandbox.daytonaSandboxId) {
    throw new Error('Sandbox runtime is not ready for terminal access yet.')
  }

  const { createSandboxSshAccessCommand } = await import('~/lib/server/daytona')

  return await withPaidSandboxAction({
    sandboxId: sandbox._id,
    agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
    eventType: 'ssh_access',
    paymentMethod,
    quantitySummary: `expires:${expiresInMinutes ?? 60}`,
    description: 'Generated Daytona SSH access.',
    releaseReason: 'SSH access generation failed before capture.',
    action: async () =>
      await createSandboxSshAccessCommand({
        daytonaSandboxId: sandbox.daytonaSandboxId!,
        expiresInMinutes,
      }),
  })
}

export async function getPortPreviewWithPayment(
  sandboxId: string,
  port: number,
  paymentMethod: BillingPaymentMethod,
) {
  const sandbox = await fetchOwnedSandboxOrThrow(sandboxId)

  if (!sandbox.daytonaSandboxId) {
    throw new Error('Sandbox runtime is not ready for preview access yet.')
  }

  const { getSandboxPortPreviewUrl } = await import('~/lib/server/daytona')

  if (port === 22222) {
    return await withPaidSandboxAction({
      sandboxId: sandbox._id,
      agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
      eventType: 'web_terminal',
      paymentMethod,
      quantitySummary: `port:${port}`,
      description: 'Opened the Daytona web terminal.',
      releaseReason: 'Web terminal access failed before capture.',
      action: async () =>
        await getSandboxPortPreviewUrl({
          daytonaSandboxId: sandbox.daytonaSandboxId!,
          port,
        }),
    })
  }

  return await getSandboxPortPreviewUrl({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    port,
  })
}
