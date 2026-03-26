import { createServerFn } from '@tanstack/react-start'
import { type BillingPaymentMethod } from '../../../convex/lib/billingConfig'
import { runServerProgram } from '~/lib/server/effect/runtime'
import type { CreateSandboxInput, SandboxPaymentMethod } from '~/lib/sandboxes'

type SandboxMutationInput = {
  sandboxId: string
  paymentMethod?: SandboxPaymentMethod
}

type EnsureAppPreviewServerInput = {
  sandboxId: string
  port: number
  paymentMethod?: SandboxPaymentMethod
}

type GetAppPreviewLogInput = {
  sandboxId: string
  port: number
  lines?: number
}

type GetAppPreviewCommandSuggestionInput = {
  sandboxId: string
  port: number
}

type ReadSandboxArtifactInput = {
  sandboxId: string
}

type SendSandboxAgentPromptInput = {
  sandboxId: string
  prompt: string
}

type CreateTerminalAccessInput = {
  sandboxId: string
  expiresInMinutes?: number
  paymentMethod?: SandboxPaymentMethod
}

type GetPortPreviewInput = {
  sandboxId: string
  port: number
  paymentMethod?: SandboxPaymentMethod
}

type GithubBranchListInput = {
  repoFullName: string
}

const APP_PREVIEW_PORT_MIN = 3000
const APP_PREVIEW_PORT_MAX = 9999

function isValidAppPreviewPort(port: number) {
  return (
    Number.isInteger(port) &&
    port >= APP_PREVIEW_PORT_MIN &&
    port <= APP_PREVIEW_PORT_MAX
  )
}

export type GithubRepoOption = {
  id: number
  fullName: string
  cloneUrl: string
  defaultBranch: string
  private: boolean
}

function getRequestedPaymentMethod(
  paymentMethod?: SandboxPaymentMethod,
): BillingPaymentMethod {
  if (paymentMethod === 'x402') {
    return 'x402'
  }

  if (paymentMethod === 'delegated_budget') {
    return 'delegated_budget'
  }

  return 'credits'
}

export const checkGithubConnection = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { checkGithubConnectionRuntime } = await import('./runtime.server')
    return await checkGithubConnectionRuntime()
  },
)

export const listGithubRepos = createServerFn({ method: 'GET' }).handler(
  async () => {
    const { listGithubReposRuntime } = await import('./runtime.server')
    return await listGithubReposRuntime()
  },
)

export const listGithubBranches = createServerFn({ method: 'POST' })
  .inputValidator((data: GithubBranchListInput) => data)
  .handler(async ({ data }) => {
    const { listGithubBranchesRuntime } = await import('./runtime.server')
    return await listGithubBranchesRuntime(data.repoFullName)
  })

export const createSandbox = createServerFn({ method: 'POST' })
  .inputValidator((data: CreateSandboxInput) => data)
  .handler(async ({ data }) => {
    const paymentMethod = getRequestedPaymentMethod(data.paymentMethod)

    if (paymentMethod === 'x402') {
      throw new Error(
        'Launch with x402 must go through the x402 HTTP endpoint.',
      )
    }

    const { createSandboxWithPayment } = await import('./runtime.server')
    return await runServerProgram(
      createSandboxWithPayment(data, paymentMethod),
    )
  })

export const deleteSandbox = createServerFn({ method: 'POST' })
  .inputValidator((data: SandboxMutationInput) => data)
  .handler(async ({ data }) => {
    const { deleteSandboxRuntime } = await import('./runtime.server')
    return await runServerProgram(deleteSandboxRuntime(data.sandboxId))
  })

export const ensureAppPreviewServer = createServerFn({ method: 'POST' })
  .inputValidator((data: EnsureAppPreviewServerInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!isValidAppPreviewPort(port)) {
      throw new Error(
        `Choose a valid preview port between ${APP_PREVIEW_PORT_MIN} and ${APP_PREVIEW_PORT_MAX}.`,
      )
    }

    const paymentMethod = getRequestedPaymentMethod(data.paymentMethod)

    if (paymentMethod === 'x402') {
      throw new Error(
        'Preview boot with x402 must go through the x402 HTTP endpoint.',
      )
    }

    const { ensureAppPreviewServerWithPayment } = await import('./runtime.server')
    return await runServerProgram(
      ensureAppPreviewServerWithPayment(data.sandboxId, port, paymentMethod),
    )
  })

export const getAppPreviewLogs = createServerFn({ method: 'POST' })
  .inputValidator((data: GetAppPreviewLogInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!isValidAppPreviewPort(port)) {
      throw new Error(
        `Choose a valid preview port between ${APP_PREVIEW_PORT_MIN} and ${APP_PREVIEW_PORT_MAX}.`,
      )
    }

    const { getAppPreviewLogsForSandbox } = await import('./runtime.server')
    return await runServerProgram(
      getAppPreviewLogsForSandbox({
        sandboxId: data.sandboxId,
        port,
        lines: data.lines,
      }),
    )
  })

export const getAppPreviewCommandSuggestion = createServerFn({ method: 'POST' })
  .inputValidator((data: GetAppPreviewCommandSuggestionInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!isValidAppPreviewPort(port)) {
      throw new Error(
        `Choose a valid preview port between ${APP_PREVIEW_PORT_MIN} and ${APP_PREVIEW_PORT_MAX}.`,
      )
    }

    const { getAppPreviewCommandSuggestionForSandbox } = await import(
      './runtime.server'
    )
    return await runServerProgram(
      getAppPreviewCommandSuggestionForSandbox({
        sandboxId: data.sandboxId,
        port,
      }),
    )
  })

export const readSandboxArtifact = createServerFn({ method: 'POST' })
  .inputValidator((data: ReadSandboxArtifactInput) => data)
  .handler(async ({ data }) => {
    const { readSandboxArtifactForSandbox } = await import('./runtime.server')
    return await runServerProgram(
      readSandboxArtifactForSandbox({
        sandboxId: data.sandboxId,
      }),
    )
  })

export const sendSandboxAgentPrompt = createServerFn({ method: 'POST' })
  .inputValidator((data: SendSandboxAgentPromptInput) => data)
  .handler(async ({ data }) => {
    const { sendPromptToSandboxAgent } = await import('./runtime.server')
    return await runServerProgram(sendPromptToSandboxAgent(data))
  })

export const createTerminalAccess = createServerFn({ method: 'POST' })
  .inputValidator((data: CreateTerminalAccessInput) => data)
  .handler(async ({ data }) => {
    const paymentMethod = getRequestedPaymentMethod(data.paymentMethod)

    if (paymentMethod === 'x402') {
      throw new Error(
        'SSH access with x402 must go through the x402 HTTP endpoint.',
      )
    }

    const { createTerminalAccessWithPayment } = await import('./runtime.server')
    return await runServerProgram(
      createTerminalAccessWithPayment(
        data.sandboxId,
        data.expiresInMinutes,
        paymentMethod,
      ),
    )
  })

export const getPortPreview = createServerFn({ method: 'POST' })
  .inputValidator((data: GetPortPreviewInput) => data)
  .handler(async ({ data }) => {
    const port = Number(data.port)

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Choose a valid preview port between 1 and 65535.')
    }

    const paymentMethod = getRequestedPaymentMethod(data.paymentMethod)

    if (port === 22222 && paymentMethod === 'x402') {
      throw new Error(
        'Web terminal with x402 must go through the x402 HTTP endpoint.',
      )
    }

    const { getPortPreviewWithPayment } = await import('./runtime.server')
    return await runServerProgram(
      getPortPreviewWithPayment(data.sandboxId, port, paymentMethod),
    )
  })

export const restartSandbox = createServerFn({ method: 'POST' })
  .inputValidator((data: SandboxMutationInput) => data)
  .handler(async ({ data }) => {
    const paymentMethod = getRequestedPaymentMethod(data.paymentMethod)

    if (paymentMethod === 'x402') {
      throw new Error(
        'Restart with x402 must go through the x402 HTTP endpoint.',
      )
    }

    const { restartSandboxWithPayment } = await import('./runtime.server')
    return await runServerProgram(
      restartSandboxWithPayment(data.sandboxId, paymentMethod),
    )
  })
