import type {
  OpenCodeAgentPreset,
  OpenCodeAgentPresetId,
} from '~/lib/opencode/presets'
import {
  getOpenCodeAgentPreset,
  resolveOpenCodeModelOption,
  withOpenCodeModelOption,
} from '~/lib/opencode/presets'
import {
  buildWorkspaceBootstrapInstructions,
  buildWorkspaceBootstrapPromptPrefix,
  type WorkspaceBootstrapRuntimeContext,
} from '~/lib/opencode/workspace-bootstrap'
import {
  encodeWorkspacePathForPreview,
  FULL_ACCESS_PERMISSION,
  getRequiredServerEnv,
  type GitHubLaunchAuth,
  type LaunchEnvironment,
  type RepositoryRuntimeContext,
  type ResolvedOpenCodeLaunchConfig,
} from './shared'

export function buildOpenCodeSessionPreviewUrl(
  previewUrl: string,
  workspacePath: string,
  sessionId?: string,
) {
  if (!sessionId) {
    return previewUrl
  }

  const trimmedPreviewUrl = previewUrl.replace(/\/+$/, '')
  const encodedWorkspacePath = encodeWorkspacePathForPreview(workspacePath)

  return `${trimmedPreviewUrl}/${encodedWorkspacePath}/session/${sessionId}`
}

function buildManagedInstructionsContent(
  preset: OpenCodeAgentPreset,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
  repositoryContext?: RepositoryRuntimeContext,
) {
  const runtimeInstructions =
    buildWorkspaceBootstrapInstructions(runtimeContext)
  const repositoryInstructions =
    buildRepositoryRuntimeInstructions(repositoryContext)

  return [preset.instructionsMd, runtimeInstructions, repositoryInstructions]
    .filter(Boolean)
    .join('\n\n')
}

export function buildManagedWorkspaceInstructionsContent(
  preset: OpenCodeAgentPreset,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
  repositoryContext?: RepositoryRuntimeContext,
) {
  return buildManagedInstructionsContent(
    preset,
    runtimeContext,
    repositoryContext,
  )
}

export function buildInitialPromptContent(
  initialPrompt: string,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
  repositoryContext?: RepositoryRuntimeContext,
) {
  const runtimePromptPrefix =
    buildWorkspaceBootstrapPromptPrefix(runtimeContext)
  const repositoryPromptPrefix =
    buildRepositoryRuntimePromptPrefix(repositoryContext)

  return [runtimePromptPrefix, repositoryPromptPrefix, initialPrompt]
    .concat(buildAutomaticCompletionPrompt())
    .filter(Boolean)
    .join('\n\n')
}

function buildAutomaticCompletionPrompt() {
  return [
    '## Required Completion Sequence',
    '',
    '- Do not stop after the first implementation pass.',
    '- In the same run, before handing work back, run the relevant build command for the repo or affected package.',
    '- Then run the relevant typecheck command or the closest validation command that covers types.',
    '- If those checks fail, fix the problem before handing work back.',
    '- If GitHub auth is available in the sandbox, commit and push the current working branch to GitHub.',
    '- Do not wait for a follow-up prompt before running this completion sequence.',
  ].join('\n')
}

function buildRepositoryRuntimeInstructions(
  context?: RepositoryRuntimeContext,
) {
  if (!context) {
    return ''
  }

  return [
    '## Runtime Git Context',
    '',
    '- BuddyPie cloned the repository and immediately moved this sandbox onto a dedicated working branch.',
    `- Base branch: \`${context.baseBranch}\``,
    `- Dedicated working branch: \`${context.workBranch}\``,
    '',
    'Stay on the dedicated working branch. Do not checkout the base branch or push directly to it.',
  ].join('\n')
}

function buildRepositoryRuntimePromptPrefix(
  context?: RepositoryRuntimeContext,
) {
  if (!context) {
    return ''
  }

  return [
    'BuddyPie already isolated this repository onto a dedicated working branch before the first prompt.',
    '',
    `- Base branch: \`${context.baseBranch}\``,
    `- Dedicated working branch: \`${context.workBranch}\``,
    '',
    'Stay on the dedicated working branch. Do not switch back to the base branch unless the user explicitly asks.',
  ].join('\n')
}

export function buildOpenCodeConfig(
  preset: OpenCodeAgentPreset,
  previewUrlPattern: string,
) {
  const usesCustomOpenRouterModel =
    preset.provider === 'openrouter' && preset.model.includes('/')
  const modelId =
    preset.provider === 'openrouter'
      ? usesCustomOpenRouterModel
        ? preset.model
        : `${preset.provider}.${preset.model}`
      : `${preset.provider}/${preset.model}`
  const openRouterProviderConfig = usesCustomOpenRouterModel
    ? {
        openrouter: {
          models: {
            [preset.model]: {},
          },
        },
      }
    : null

  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: modelId,
    ...(openRouterProviderConfig
      ? {
          provider: openRouterProviderConfig,
          providers: openRouterProviderConfig,
        }
      : {}),
    default_agent: preset.id,
    instructions: ['.buddypie/opencode/AGENTS.md'],
    permission: FULL_ACCESS_PERMISSION,
    agent: {
      [preset.id]: {
        description: preset.description,
        mode: 'primary',
        model: modelId,
        prompt: [
          'You are running in a Daytona sandbox.',
          'Use the /home/daytona directory instead of /workspace for file operations.',
          `When running services on localhost, they will be accessible as: ${previewUrlPattern}`,
          'When starting a server, always give the user the preview URL to access it.',
          'When starting a server, start it in the background with & so the command does not block further instructions.',
          preset.agentPrompt,
        ].join(' '),
        permission: FULL_ACCESS_PERMISSION,
      },
    },
    ...(Object.keys(preset.mcp).length > 0 ? { mcp: preset.mcp } : {}),
  })
}

function buildLaunchEnvironment(
  preset: OpenCodeAgentPreset,
  githubAuth?: GitHubLaunchAuth | null,
): LaunchEnvironment {
  const environment: LaunchEnvironment = {}

  for (const envName of preset.requiredEnv) {
    environment[envName] = getRequiredServerEnv(envName)

    if (envName === 'VENICE_API_KEY') {
      environment.VENICE_INFERENCE_KEY = environment[envName]
    } else if (envName === 'VENICE_INFERENCE_KEY') {
      environment.VENICE_API_KEY = environment[envName]
    } else if (envName === 'ZAI_API_KEY') {
      environment.ZHIPU_API_KEY = environment[envName]
    } else if (envName === 'ZHIPU_API_KEY') {
      environment.ZAI_API_KEY = environment[envName]
    }
  }

  for (const mcp of Object.values(preset.mcp)) {
    for (const envName of mcp.env ?? []) {
      const value = process.env[envName]?.trim()

      if (value) {
        environment[envName] = value
      }
    }
  }

  if (githubAuth?.token) {
    environment.GITHUB_TOKEN = githubAuth.token
    environment.GH_TOKEN = githubAuth.token

    if (githubAuth.scopes.length > 0) {
      environment.GITHUB_OAUTH_SCOPES = githubAuth.scopes.join(',')
    }

    if (githubAuth.accountLogin) {
      environment.GITHUB_OAUTH_ACCOUNT_LOGIN = githubAuth.accountLogin
      environment.GITHUB_ACTOR = githubAuth.accountLogin
    }
  }

  return environment
}

export function resolveOpenCodeLaunchConfig(args: {
  agentPresetId: string
  agentProvider?: string
  agentModel?: string
  githubAuth?: GitHubLaunchAuth | null
}): ResolvedOpenCodeLaunchConfig {
  const presetDefaults = getOpenCodeAgentPreset(args.agentPresetId)
  const modelOption = resolveOpenCodeModelOption({
    provider: args.agentProvider,
    model: args.agentModel,
    fallbackProvider: presetDefaults.provider,
    fallbackModel: presetDefaults.model,
  })
  const preset = withOpenCodeModelOption(presetDefaults, modelOption)

  return {
    preset,
    launchEnvironment: buildLaunchEnvironment(preset, args.githubAuth),
  }
}

export function getDocsPresetWorkspaceBootstrap() {
  return getOpenCodeAgentPreset('docs-writer').workspaceBootstrap
}

export function getPresetById(agentPresetId: OpenCodeAgentPresetId | string) {
  return getOpenCodeAgentPreset(agentPresetId)
}
