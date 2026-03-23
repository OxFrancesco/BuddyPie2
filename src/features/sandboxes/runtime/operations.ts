import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import type { BillingPaymentMethod } from '../../../../convex/lib/billingConfig'
import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'
import {
  createSandboxSshAccessCommand,
  ensureSandboxAppPreviewServer,
  getSandboxAppPreviewCommandSuggestion,
  getSandboxAppPreviewLogTail,
  getSandboxPortPreviewUrl,
  readSandboxCurrentArtifact,
  sendPromptToSandboxOpencodeSession,
} from '~/lib/server/daytona'
import { withPaidSandboxAction } from './payments'

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

export async function ensureAppPreviewServerWithPayment(
  sandboxId: string,
  port: number,
  paymentMethod: BillingPaymentMethod,
) {
  const sandbox = await fetchOwnedSandboxOrThrow(sandboxId)

  if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
    throw new Error('Sandbox runtime is not ready for app preview yet.')
  }

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
        previewAppPath: sandbox.previewAppPath,
        agentPresetId: sandbox.agentPresetId,
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

  return await getSandboxAppPreviewLogTail({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    workspacePath: sandbox.workspacePath,
    previewAppPath: sandbox.previewAppPath,
    agentPresetId: sandbox.agentPresetId,
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

  return await getSandboxAppPreviewCommandSuggestion({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    workspacePath: sandbox.workspacePath,
    previewAppPath: sandbox.previewAppPath,
    agentPresetId: sandbox.agentPresetId,
    port: args.port,
  })
}

export async function readSandboxArtifactForSandbox(args: {
  sandboxId: string
}) {
  const sandbox = await fetchOwnedSandboxOrThrow(args.sandboxId)

  if (!sandbox.daytonaSandboxId || !sandbox.workspacePath) {
    throw new Error('Sandbox runtime is not ready for artifact retrieval yet.')
  }

  return await readSandboxCurrentArtifact({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    workspacePath: sandbox.workspacePath,
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

export async function sendPromptToSandboxAgent(args: {
  sandboxId: string
  prompt: string
}) {
  const sandbox = await fetchOwnedSandboxOrThrow(args.sandboxId)

  if (
    !sandbox.daytonaSandboxId ||
    !sandbox.workspacePath ||
    !sandbox.opencodeSessionId
  ) {
    throw new Error('Sandbox runtime is not ready for agent prompts yet.')
  }

  return await sendPromptToSandboxOpencodeSession({
    daytonaSandboxId: sandbox.daytonaSandboxId,
    workspacePath: sandbox.workspacePath,
    agentPresetId: sandbox.agentPresetId ?? 'general-engineer',
    opencodeSessionId: sandbox.opencodeSessionId,
    prompt: args.prompt,
  })
}
