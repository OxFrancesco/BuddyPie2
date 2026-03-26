import { Daytona } from '@daytonaio/sdk'
import type { Sandbox } from '@daytonaio/sdk'

export const OPENCODE_PORT = 3000
export const OPENCODE_VERSION = '1.2.26'
export const NANSEN_CLI_VERSION = '1.20.0'
export const READY_TIMEOUT_MS = 15000
export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api'
export const APP_PREVIEW_PORT_PROBE_TIMEOUT_SECONDS = 5
export const APP_PREVIEW_START_TIMEOUT_SECONDS = 300
export const APP_PREVIEW_BOOT_TIMEOUT_MS = 40_000
export const APP_PREVIEW_BOOT_POLL_INTERVAL_MS = 1_500
export const APP_PREVIEW_LOG_TAIL_LINES = 120
export const APP_PREVIEW_MIN_PORT = 3000
export const APP_PREVIEW_MAX_PORT = 9999
export const FULL_ACCESS_PERMISSION = 'allow' as const
export const PREVIEW_SCRIPT_PREFERENCE = [
  'dev:web',
  'dev',
  'preview',
  'start',
  'web',
  'server',
] as const
const SHARED_ENV_FALLBACKS: Record<string, Array<string>> = {
  VENICE_API_KEY: ['VENICE_INFERENCE_KEY'],
  VENICE_INFERENCE_KEY: ['VENICE_API_KEY'],
  ZAI_API_KEY: ['ZHIPU_API_KEY'],
  ZHIPU_API_KEY: ['ZAI_API_KEY'],
}

export type LaunchEnvironment = Record<string, string>

export type GitHubLaunchAuth = {
  token: string
  scopes: Array<string>
  accountLogin?: string
  accountName?: string
  accountEmail?: string
}

export type ExecuteCommandResponse = {
  artifacts?: {
    stdout?: string
  }
  exitCode?: number
  result?: string
  stdout?: string
  output?: string
}

export type WorkspaceBootstrapResult = {
  runtimeContext?: import('~/lib/opencode/workspace-bootstrap').WorkspaceBootstrapRuntimeContext
}

export type PreviewTargetResolution = {
  previewAppPath: string
}

export type PreviewCommandMetadata = {
  framework: string
  packageManager: string
  previewScript: string
}

export type RepositoryRuntimeContext = {
  baseBranch: string
  workBranch: string
}

export type ResolvedOpenCodeLaunchConfig = {
  preset: import('~/lib/opencode/presets').OpenCodeAgentPreset
  launchEnvironment: LaunchEnvironment
}

export const SEEDED_SESSION_PAYLOAD_MARKER = '__BUDDYPIE_SEEDED_SESSION__'

export type SandboxGitClient = Pick<
  Sandbox['git'],
  'checkoutBranch' | 'clone' | 'createBranch' | 'deleteBranch' | 'status'
>

export function injectEnvVar(name: string, content: string) {
  const base64 = Buffer.from(content).toString('base64')
  return `${name}=$(echo '${base64}' | base64 -d)`
}

export function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function encodeWorkspacePathForPreview(value: string) {
  return base64UrlEncode(value)
}

export function getRequiredServerEnv(name: string) {
  const envCandidates = [name, ...(SHARED_ENV_FALLBACKS[name] ?? [])]

  for (const candidate of envCandidates) {
    const value = process.env[candidate]?.trim()

    if (value) {
      return value
    }
  }

  if (envCandidates.length > 1) {
    throw new Error(
      `${envCandidates.join(' or ')} is not configured on the server.`,
    )
  }

  throw new Error(`${name} is not configured on the server.`)
}

export function getRequiredDaytonaApiKey() {
  return getRequiredServerEnv('DAYTONA_API_KEY')
}

export function getDaytonaApiUrl() {
  const configuredApiUrl = process.env.DAYTONA_API_URL?.trim()

  if (!configuredApiUrl) {
    return DEFAULT_DAYTONA_API_URL
  }

  let parsedUrl: URL

  try {
    parsedUrl = new URL(configuredApiUrl)
  } catch {
    throw new Error(
      `DAYTONA_API_URL is invalid. Expected a full URL like ${DEFAULT_DAYTONA_API_URL}.`,
    )
  }

  if (parsedUrl.hostname === 'api.daytona.ai') {
    return DEFAULT_DAYTONA_API_URL
  }

  return configuredApiUrl
}

export function createDaytonaClient() {
  return new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
}

export function getCommandStdout(response: ExecuteCommandResponse) {
  return (
    response.artifacts?.stdout ??
    response.stdout ??
    response.result ??
    response.output ??
    ''
  )
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function summarizeCommandOutput(output: string) {
  const trimmed = output.trim()

  if (!trimmed) {
    return 'No command output was captured.'
  }

  const collapsedWhitespace = trimmed.replace(/\s+/g, ' ')
  return collapsedWhitespace.length > 400
    ? `${collapsedWhitespace.slice(0, 397)}...`
    : collapsedWhitespace
}

export function parseSeededSessionPayload(stdout: string) {
  const markerIndex = stdout.lastIndexOf(SEEDED_SESSION_PAYLOAD_MARKER)
  const rawPayload =
    markerIndex >= 0
      ? stdout.slice(markerIndex + SEEDED_SESSION_PAYLOAD_MARKER.length).trim()
      : stdout.trim()

  if (!rawPayload) {
    throw new Error('OpenCode did not return a seeded session payload.')
  }

  try {
    return JSON.parse(rawPayload) as {
      sessionId?: string
    }
  } catch {
    throw new Error(
      `OpenCode returned an invalid seeded session payload: ${summarizeCommandOutput(stdout)}`,
    )
  }
}

export function parseJsonCommandOutput<T>(response: ExecuteCommandResponse) {
  const stdout = getCommandStdout(response).trim()

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(summarizeCommandOutput(stdout))
  }

  if (!stdout) {
    throw new Error('No command output was captured.')
  }

  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new Error(
      `Command returned invalid JSON: ${summarizeCommandOutput(stdout)}`,
    )
  }
}
