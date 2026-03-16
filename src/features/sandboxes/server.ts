import { createServerFn } from '@tanstack/react-start'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import type { CreateSandboxInput } from '~/lib/sandboxes'
import { getSafeOpenCodeAgentPreset } from '~/lib/opencode/presets'
import { normalizeSandboxInput } from '~/lib/sandboxes'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'

type SandboxMutationInput = {
  sandboxId: string
}

type EnsureAppPreviewServerInput = {
  sandboxId: string
  port: number
}

type GetAppPreviewLogInput = {
  sandboxId: string
  port: number
  lines?: number
}

type CreateTerminalAccessInput = {
  sandboxId: string
  expiresInMinutes?: number
}

type GetPortPreviewInput = {
  sandboxId: string
  port: number
}

type GithubBranchListInput = {
  repoFullName: string
}

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

export type GithubRepoOption = {
  id: number
  fullName: string
  cloneUrl: string
  defaultBranch: string
  private: boolean
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
    throw new Error('Your GitHub access expired. Refresh the GitHub connection in Clerk and try again.')
  }

  if (response.status === 403) {
    throw new Error('GitHub denied access. Refresh the GitHub connection in Clerk and make sure repo access is granted.')
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

  return {
    agentPresetId: preset.id,
    agentLabel: input.agentLabel ?? preset.label,
    agentProvider: input.agentProvider ?? preset.provider,
    agentModel: input.agentModel ?? preset.model,
    initialPrompt: input.initialPrompt?.trim() || preset.starterPrompt,
  }
}

async function withSandboxEventLease<T>(args: {
  convexUrl: string
  token: string
  sandboxId: Id<'sandboxes'>
  eventType: 'preview_boot' | 'ssh_access' | 'web_terminal'
  quantitySummary?: string
  idempotencyKey: string
  description: string
  action: () => Promise<T>
  shouldCapture?: (result: T) => boolean
  releaseReason?: string
}) {
  const leaseResponse = await fetch(`${args.convexUrl}/billing/leases/create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sandboxId: args.sandboxId,
      eventType: args.eventType,
      idempotencyKey: args.idempotencyKey,
      quantitySummary: args.quantitySummary,
    }),
  })

  if (!leaseResponse.ok) {
    const error = (await leaseResponse.json().catch(() => null)) as
      | { error?: string }
      | null

    throw new Error(error?.error ?? `Could not create ${args.eventType} lease.`)
  }

  const lease = (await leaseResponse.json()) as { _id: string }

  try {
    const result = await args.action()

    if (args.shouldCapture && !args.shouldCapture(result)) {
      const releaseResponse = await fetch(
        `${args.convexUrl}/billing/leases/release`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${args.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            leaseId: lease._id,
            reason: args.releaseReason ?? `No charge captured for ${args.eventType}.`,
          }),
        },
      )

      if (!releaseResponse.ok) {
        const error = (await releaseResponse.json().catch(() => null)) as
          | { error?: string }
          | null

        throw new Error(error?.error ?? `Could not release ${args.eventType} lease.`)
      }

      return result
    }

    const captureResponse = await fetch(
      `${args.convexUrl}/billing/leases/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          leaseId: lease._id,
          sandboxId: args.sandboxId,
          eventType: args.eventType,
          idempotencyKey: `capture:${args.idempotencyKey}`,
          description: args.description,
          quantitySummary: args.quantitySummary,
        }),
      },
    )

    if (!captureResponse.ok) {
      const error = (await captureResponse.json().catch(() => null)) as
        | { error?: string }
        | null

      throw new Error(error?.error ?? `Could not capture ${args.eventType} lease.`)
    }

    return result
  } catch (error) {
    try {
      await fetch(`${args.convexUrl}/billing/leases/release`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          leaseId: lease._id,
          reason: args.releaseReason ?? `${args.eventType} failed before capture.`,
        }),
      })
    } catch {
      // Best effort cleanup if the action throws after the lease is held.
    }

    throw error
  }
}

async function fetchGithubRepos(githubToken: string) {
  // Keep the launcher lightweight by fetching only the user's most recent repos.
  return githubRequest<Array<GithubApiRepo>>(
    githubToken,
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=10',
  )
}

export const checkGithubConnection = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { userId } = await getAuthenticatedConvexClient()
    const githubToken = await getGithubAccessToken(userId)

    return {
      connected: Boolean(githubToken),
      message: githubToken
        ? 'GitHub is connected and ready for private repository imports.'
        : 'Connect GitHub from your Clerk profile to import private repositories.',
    }
  },
)

export const listGithubRepos = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { userId } = await getAuthenticatedConvexClient()
    const githubToken = await getRequiredGithubAccessToken(userId)
    const repos = await fetchGithubRepos(githubToken)
    const repoOptions: Array<GithubRepoOption> = repos.map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch,
      private: repo.private,
    }))

    return repoOptions
  },
)

export const listGithubBranches = createServerFn({ method: 'POST' })
  .inputValidator((data: GithubBranchListInput) => data)
  .handler(async ({ data }) => {
    const repoFullName = data.repoFullName.trim()
    const [owner, repo, ...rest] = repoFullName.split('/')

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
  })

export const createSandbox = createServerFn({ method: 'POST' })
  .inputValidator((data: CreateSandboxInput) => data)
  .handler(async ({ data }) => {
    const normalized = normalizeSandboxInput(data)
    const { convex, userId } = await getAuthenticatedConvexClient()
    await convex.mutation(api.user.ensureCurrentUser, {})

    const pendingSandbox = await convex.mutation(api.sandboxes.createPending, {
      repoUrl: normalized.repoUrl,
      repoName: normalized.repoName,
      repoBranch: normalized.branch,
      repoProvider: normalized.repoProvider,
      agentPresetId: normalized.agentPresetId,
      agentLabel: normalized.agentLabel,
      agentProvider: normalized.agentProvider,
      agentModel: normalized.agentModel,
      initialPrompt: normalized.initialPrompt,
    })
    let launched: LaunchedSandbox | null = null

    try {
      const githubToken =
        normalized.repoProvider === 'github'
          ? await getGithubAccessToken(userId)
          : null
      const { createOpenCodeSandbox } = await import('~/lib/server/daytona')
      launched = await createOpenCodeSandbox({
        repoUrl: normalized.repoUrl,
        branch: normalized.branch,
        agentPresetId: normalized.agentPresetId,
        initialPrompt: normalized.initialPrompt,
        githubToken,
      })
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
  })

export const deleteSandbox = createServerFn({ method: 'POST' })
  .inputValidator((data: SandboxMutationInput) => data)
  .handler(async ({ data }) => {
    const { convex } = await getAuthenticatedConvexClient()
    const sandbox = await convex.query(api.sandboxes.get, {
      sandboxId: data.sandboxId as Id<'sandboxes'>,
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
  })

export const ensureAppPreviewServer = createServerFn({ method: 'POST' })
  .inputValidator((data: EnsureAppPreviewServerInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Choose a valid preview port between 1 and 65535.')
    }

    const { convex, convexUrl, token } = await getAuthenticatedConvexClient()
    const sandbox = await convex.query(api.sandboxes.get, {
      sandboxId: data.sandboxId as Id<'sandboxes'>,
    })

    if (!sandbox) {
      throw new Error('Sandbox not found.')
    }

    if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
      throw new Error('Sandbox runtime is not ready for app preview yet.')
    }

    const daytonaSandboxId = sandbox.daytonaSandboxId
    const workspacePath = sandbox.workspacePath
    const { ensureSandboxAppPreviewServer } = await import('~/lib/server/daytona')
    const previewAttemptKey = `preview-boot:${sandbox._id}:${port}:${Date.now()}`

    return await withSandboxEventLease({
      convexUrl,
      token,
      sandboxId: sandbox._id,
      eventType: 'preview_boot',
      idempotencyKey: previewAttemptKey,
      quantitySummary: `port:${port}`,
      description: `Preview boot on port ${port}`,
      shouldCapture: (result) => result.status === 'started',
      releaseReason: `Preview server on port ${port} did not need a new boot charge.`,
      action: async () =>
        await ensureSandboxAppPreviewServer({
          daytonaSandboxId,
          workspacePath,
          port,
        }),
    })
  })

export const getAppPreviewLogs = createServerFn({ method: 'POST' })
  .inputValidator((data: GetAppPreviewLogInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Choose a valid preview port between 1 and 65535.')
    }

    const { convex } = await getAuthenticatedConvexClient()
    const sandbox = await convex.query(api.sandboxes.get, {
      sandboxId: data.sandboxId as Id<'sandboxes'>,
    })

    if (!sandbox) {
      throw new Error('Sandbox not found.')
    }

    if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
      throw new Error('Sandbox runtime is not ready for log retrieval yet.')
    }

    const { getSandboxAppPreviewLogTail } = await import('~/lib/server/daytona')

    return await getSandboxAppPreviewLogTail({
      daytonaSandboxId: sandbox.daytonaSandboxId,
      workspacePath: sandbox.workspacePath,
      port,
      lines: data.lines,
    })
  })

export const createTerminalAccess = createServerFn({ method: 'POST' })
  .inputValidator((data: CreateTerminalAccessInput) => data)
  .handler(async ({ data }) => {
    const { convex, convexUrl, token } = await getAuthenticatedConvexClient()
    const sandbox = await convex.query(api.sandboxes.get, {
      sandboxId: data.sandboxId as Id<'sandboxes'>,
    })

    if (!sandbox) {
      throw new Error('Sandbox not found.')
    }

    if (!sandbox.daytonaSandboxId) {
      throw new Error('Sandbox runtime is not ready for terminal access yet.')
    }

    const daytonaSandboxId = sandbox.daytonaSandboxId
    const { createSandboxSshAccessCommand } = await import('~/lib/server/daytona')
    const sshAttemptKey = `ssh-access:${sandbox._id}:${Date.now()}`

    return await withSandboxEventLease({
      convexUrl,
      token,
      sandboxId: sandbox._id,
      eventType: 'ssh_access',
      idempotencyKey: sshAttemptKey,
      quantitySummary: `expires:${data.expiresInMinutes ?? 60}`,
      description: 'Generated Daytona SSH access.',
      releaseReason: 'SSH access generation failed before capture.',
      action: async () =>
        await createSandboxSshAccessCommand({
          daytonaSandboxId,
          expiresInMinutes: data.expiresInMinutes,
        }),
    })
  })

export const getPortPreview = createServerFn({ method: 'POST' })
  .inputValidator((data: GetPortPreviewInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Choose a valid preview port between 1 and 65535.')
    }

    const { convex, convexUrl, token } = await getAuthenticatedConvexClient()
    const sandbox = await convex.query(api.sandboxes.get, {
      sandboxId: data.sandboxId as Id<'sandboxes'>,
    })

    if (!sandbox) {
      throw new Error('Sandbox not found.')
    }

    if (!sandbox.daytonaSandboxId) {
      throw new Error('Sandbox runtime is not ready for preview access yet.')
    }

    const daytonaSandboxId = sandbox.daytonaSandboxId
    const { getSandboxPortPreviewUrl } = await import('~/lib/server/daytona')

    if (port === 22222) {
      const terminalAttemptKey = `web-terminal:${sandbox._id}:${port}:${Date.now()}`

      return await withSandboxEventLease({
        convexUrl,
        token,
        sandboxId: sandbox._id,
        eventType: 'web_terminal',
        idempotencyKey: terminalAttemptKey,
        quantitySummary: `port:${port}`,
        description: 'Opened the Daytona web terminal.',
        releaseReason: 'Web terminal access failed before capture.',
        action: async () =>
          await getSandboxPortPreviewUrl({
            daytonaSandboxId,
            port,
          }),
      })
    }

    return await getSandboxPortPreviewUrl({
      daytonaSandboxId,
      port,
    })
  })

export const restartSandbox = createServerFn({ method: 'POST' })
  .inputValidator((data: SandboxMutationInput) => data)
  .handler(async ({ data }) => {
    const { convex, userId } = await getAuthenticatedConvexClient()
    const sandbox = await convex.query(api.sandboxes.get, {
      sandboxId: data.sandboxId as Id<'sandboxes'>,
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
    })
    let launched: LaunchedSandbox | null = null

    try {
      const githubToken =
        sandbox.repoProvider === 'github'
          ? await getGithubAccessToken(userId)
          : null
      const { createOpenCodeSandbox, deleteOpenCodeSandbox } = await import(
        '~/lib/server/daytona'
      )
      launched = await createOpenCodeSandbox({
        repoUrl: sandbox.repoUrl,
        branch: sandbox.repoBranch,
        agentPresetId: restartPreset.agentPresetId,
        initialPrompt: restartPreset.initialPrompt,
        githubToken,
      })
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
  })
