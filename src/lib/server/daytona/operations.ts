import {
  getSandboxArtifactManifestPath,
  parseSandboxArtifactManifest,
  type SandboxArtifactReadResult,
} from '~/lib/artifacts'
import {
  buildInitialPromptContent,
  buildOpenCodeSessionPreviewUrl,
  getPresetById,
  resolveOpenCodeLaunchConfig,
} from './launch-config'
import {
  seedInitialPrompt,
  sendPromptToExistingSession,
  startOpencodeWeb,
} from './opencode'
import { resolveLaunchPreviewAppPath } from './preview'
import { createDaytonaClient } from './shared'
import {
  bootstrapWorkspace,
  configureGitHubAuthForSandbox,
  downloadTextFile,
  installManagedSandboxTooling,
  prepareSandboxWorkspace,
  writeManagedWorkspaceFiles,
} from './workspace'

export async function createOpenCodeSandbox(args: {
  repoUrl?: string
  branch?: string
  agentPresetId: string
  agentProvider?: string
  agentModel?: string
  initialPrompt?: string
  githubAuth?: import('./shared').GitHubLaunchAuth | null
}) {
  const daytona = createDaytonaClient()
  const { preset, launchEnvironment } = resolveOpenCodeLaunchConfig({
    agentPresetId: args.agentPresetId,
    agentProvider: args.agentProvider,
    agentModel: args.agentModel,
    githubAuth: args.githubAuth,
  })
  let sandbox: import('@daytonaio/sdk').Sandbox | undefined

  try {
    sandbox = await daytona.create({
      public: true,
      autoStopInterval: 30,
    })

    const repo = await prepareSandboxWorkspace({
      sandbox,
      repoUrl: args.repoUrl,
      branch: args.branch,
      preset,
      initialPrompt: args.initialPrompt,
      githubAuth: args.githubAuth,
    })
    if (repo.repoProvider === 'github') {
      await configureGitHubAuthForSandbox({
        sandbox,
        workspacePath: repo.workspacePath,
        githubAuth: args.githubAuth,
      })
    }
    const workspaceBootstrap = await bootstrapWorkspace({
      sandbox,
      workspacePath: repo.workspacePath,
      preset,
    })
    const seededInitialPrompt = buildInitialPromptContent(
      repo.initialPrompt,
      workspaceBootstrap.runtimeContext,
      repo.repositoryContext,
    )
    const previewAppPath = resolveLaunchPreviewAppPath({
      preset,
      workspacePath: repo.workspacePath,
      runtimeContext: workspaceBootstrap.runtimeContext,
    })

    await writeManagedWorkspaceFiles(
      sandbox,
      repo.workspacePath,
      preset,
      workspaceBootstrap.runtimeContext,
      repo.repositoryContext,
    )
    await installManagedSandboxTooling({
      sandbox,
      workspacePath: repo.workspacePath,
      preset,
      launchEnvironment,
    })

    const { previewUrl, previewUrlPattern } = await startOpencodeWeb({
      sandbox,
      workspacePath: repo.workspacePath,
      preset,
      launchEnvironment,
    })
    const opencodeSessionId = await seedInitialPrompt({
      sandbox,
      workspacePath: repo.workspacePath,
      repoName: repo.repoName,
      preset,
      initialPrompt: seededInitialPrompt,
    })

    const sessionPreviewUrl = buildOpenCodeSessionPreviewUrl(
      previewUrl,
      repo.workspacePath,
      opencodeSessionId,
    )

    return {
      repoName: repo.repoName,
      repoProvider: repo.repoProvider,
      branch: repo.branch,
      workspacePath: repo.workspacePath,
      previewAppPath,
      previewUrl: sessionPreviewUrl,
      previewUrlPattern,
      daytonaSandboxId: sandbox.id,
      opencodeSessionId,
    }
  } catch (error) {
    if (sandbox) {
      try {
        await sandbox.delete()
      } catch {
        // Best effort cleanup for failed launches.
      }
    }

    throw error
  }
}

export async function deleteOpenCodeSandbox(daytonaSandboxId: string) {
  const sandbox = await createDaytonaClient().get(daytonaSandboxId)
  await sandbox.delete()
}

export async function readSandboxCurrentArtifact(args: {
  daytonaSandboxId: string
  workspacePath: string
}): Promise<SandboxArtifactReadResult> {
  const manifestPath = getSandboxArtifactManifestPath(args.workspacePath)
  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const content = await downloadTextFile(sandbox, manifestPath)

  return parseSandboxArtifactManifest({
    manifestPath,
    content,
  })
}

export async function sendPromptToSandboxOpencodeSession(args: {
  daytonaSandboxId: string
  workspacePath: string
  agentPresetId: string
  opencodeSessionId: string
  prompt: string
}) {
  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const preset = getPresetById(args.agentPresetId)

  await sendPromptToExistingSession({
    sandbox,
    workspacePath: args.workspacePath,
    preset,
    sessionId: args.opencodeSessionId,
    prompt: args.prompt,
  })

  return {
    status: 'queued' as const,
    sessionId: args.opencodeSessionId,
  }
}
