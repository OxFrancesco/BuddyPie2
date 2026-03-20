import { posix as pathPosix } from 'node:path'
import { Daytona } from '@daytonaio/sdk'
import type { Sandbox } from '@daytonaio/sdk'
import type {
  OpenCodeAgentPreset,
  OpenCodeAgentPresetId,
  OpenCodeSkillPermission,
} from '~/lib/opencode/presets'
import {
  getOpenCodeAgentPreset,
  resolveOpenCodeModelOption,
  withOpenCodeModelOption,
} from '~/lib/opencode/presets'
import {
  buildWorkspaceBootstrapInstructions,
  buildWorkspaceBootstrapPromptPrefix,
  ensureDirectoryInGitignore,
  resolveDocsAppPath,
  type DocsAppPathInspection,
  type WorkspaceBootstrapRuntimeContext,
} from '~/lib/opencode/workspace-bootstrap'
import { getWorkspacePath, normalizeSandboxInput } from '~/lib/sandboxes'

const OPENCODE_PORT = 3000
const OPENCODE_VERSION = '1.2.26'
const READY_TIMEOUT_MS = 15000
const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api'
const APP_PREVIEW_PORT_PROBE_TIMEOUT_SECONDS = 5
const APP_PREVIEW_START_TIMEOUT_SECONDS = 300
const APP_PREVIEW_BOOT_TIMEOUT_MS = 40_000
const APP_PREVIEW_BOOT_POLL_INTERVAL_MS = 1_500
const APP_PREVIEW_LOG_TAIL_LINES = 120
const SHARED_ENV_FALLBACKS: Record<string, Array<string>> = {
  VENICE_API_KEY: ['VENICE_INFERENCE_KEY'],
  VENICE_INFERENCE_KEY: ['VENICE_API_KEY'],
  ZAI_API_KEY: ['ZHIPU_API_KEY'],
  ZHIPU_API_KEY: ['ZAI_API_KEY'],
}

type LaunchEnvironment = Record<string, string>

type ExecuteCommandResponse = {
  artifacts?: {
    stdout?: string
  }
  exitCode?: number
  result?: string
  stdout?: string
  output?: string
}

type WorkspaceBootstrapResult = {
  runtimeContext?: WorkspaceBootstrapRuntimeContext
}

type ResolvedOpenCodeLaunchConfig = {
  preset: OpenCodeAgentPreset
  launchEnvironment: LaunchEnvironment
}

const SEEDED_SESSION_PAYLOAD_MARKER = '__BUDDYPIE_SEEDED_SESSION__'

function injectEnvVar(name: string, content: string) {
  const base64 = Buffer.from(content).toString('base64')
  return `${name}=$(echo '${base64}' | base64 -d)`
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function buildOpenCodeSessionPreviewUrl(
  previewUrl: string,
  workspacePath: string,
  sessionId?: string,
) {
  if (!sessionId) {
    return previewUrl
  }

  const trimmedPreviewUrl = previewUrl.replace(/\/+$/, '')
  const encodedWorkspacePath = base64UrlEncode(workspacePath)

  return `${trimmedPreviewUrl}/${encodedWorkspacePath}/session/${sessionId}`
}

function getRequiredDaytonaApiKey() {
  return getRequiredServerEnv('DAYTONA_API_KEY')
}

function getRequiredServerEnv(name: string) {
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

function getDaytonaApiUrl() {
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

function getCommandStdout(response: ExecuteCommandResponse) {
  return (
    response.artifacts?.stdout ??
    response.stdout ??
    response.result ??
    response.output ??
    ''
  )
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function buildPortProbeScript() {
  return `
const net = require('node:net')
const port = Number(process.argv[1])
const socket = net.connect({ host: '127.0.0.1', port })
socket.setTimeout(1200)
const fail = () => {
  socket.destroy()
  process.exit(1)
}
socket.once('connect', () => {
  socket.end()
  process.exit(0)
})
socket.once('timeout', fail)
socket.once('error', fail)
`.trim()
}

function buildPreviewStartCommand(port: number) {
  const previewLogPath = `.buddypie/logs/app-preview-${port}.log`

  return `
set -e
mkdir -p .buddypie/logs

if [ ! -f package.json ]; then
  echo "No package.json found in workspace."
  exit 1
fi

PREVIEW_METADATA=$(node <<'NODE'
const fs = require('node:fs')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const scripts = pkg.scripts ?? {}
const deps = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
}
const packageManagerField =
  typeof pkg.packageManager === 'string' ? pkg.packageManager : ''
const packageManagerName = packageManagerField.split('@')[0]
const hasFile = (name) => fs.existsSync(name)
const scriptPreference = ['dev:web', 'dev', 'start', 'web', 'server']
const previewScript =
  scriptPreference.find((name) => typeof scripts[name] === 'string') ?? ''
const previewScriptCommand =
  typeof scripts[previewScript] === 'string' ? scripts[previewScript] : ''

let packageManager = 'npm'

if (
  packageManagerName === 'bun' ||
  hasFile('bun.lock') ||
  hasFile('bun.lockb')
) {
  packageManager = 'bun'
} else if (
  packageManagerName === 'pnpm' ||
  hasFile('pnpm-lock.yaml')
) {
  packageManager = 'pnpm'
} else if (
  packageManagerName === 'yarn' ||
  hasFile('yarn.lock')
) {
  packageManager = 'yarn'
}

let framework = 'generic'
const script = previewScriptCommand.toLowerCase()

if (deps.expo || script.includes('expo ')) {
  framework = 'expo'
} else if (deps.next || script.includes('next ')) {
  framework = 'next'
} else if (
  deps.astro ||
  script.includes('astro ') ||
  script.startsWith('astro')
) {
  framework = 'astro'
} else if (
  deps.vite ||
  deps['@sveltejs/kit'] ||
  deps['solid-start'] ||
  script.includes('vite ') ||
  script.startsWith('vite')
) {
  framework = 'vite'
} else if (
  deps['react-scripts'] ||
  script.includes('react-scripts ')
) {
  framework = 'cra'
}

process.stdout.write(
  JSON.stringify({
    framework,
    packageManager,
    previewScript,
  }),
)
NODE
)

PREVIEW_SCRIPT=$(node -e "const meta=JSON.parse(process.argv[1]);process.stdout.write(meta.previewScript||'')" "$PREVIEW_METADATA")

if [ -z "$PREVIEW_SCRIPT" ]; then
  echo "No supported preview script found in package.json. Expected one of dev:web, dev, start, web, or server."
  exit 1
fi

PACKAGE_MANAGER=$(node -e "const meta=JSON.parse(process.argv[1]);process.stdout.write(meta.packageManager||'npm')" "$PREVIEW_METADATA")
FRAMEWORK=$(node -e "const meta=JSON.parse(process.argv[1]);process.stdout.write(meta.framework||'generic')" "$PREVIEW_METADATA")

if [ "$PACKAGE_MANAGER" = "bun" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
elif [ "$PACKAGE_MANAGER" = "pnpm" ] || [ "$PACKAGE_MANAGER" = "yarn" ]; then
  corepack enable >/dev/null 2>&1 || true
fi

if ! command -v "$PACKAGE_MANAGER" >/dev/null 2>&1; then
  echo "Package manager '$PACKAGE_MANAGER' is unavailable in the sandbox, falling back to npm."
  PACKAGE_MANAGER="npm"
fi

if [ ! -d node_modules ]; then
  case "$PACKAGE_MANAGER" in
    bun)
      bun install --frozen-lockfile || bun install
      ;;
    pnpm)
      pnpm install --frozen-lockfile || pnpm install
      ;;
    yarn)
      yarn install --immutable || yarn install --frozen-lockfile || yarn install
      ;;
    *)
      if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
        npm ci || npm install
      else
        npm install
      fi
      ;;
  esac
fi

PREVIEW_START_COMMAND=$(node - "$PACKAGE_MANAGER" "$FRAMEWORK" "$PREVIEW_SCRIPT" "${port}" <<'NODE'
const [packageManager, framework, previewScript, port] = process.argv.slice(2)

function buildRunCommand(pm, script, args) {
  if (pm === 'yarn') {
    return args ? 'yarn ' + script + ' ' + args : 'yarn ' + script
  }

  if (pm === 'bun') {
    return args
      ? 'export PATH="$HOME/.bun/bin:$PATH" && $HOME/.bun/bin/bun run ' +
          script +
          ' ' +
          args
      : 'export PATH="$HOME/.bun/bin:$PATH" && $HOME/.bun/bin/bun run ' + script
  }

  const baseCommand = pm + ' run ' + script
  return args ? baseCommand + ' -- ' + args : baseCommand
}

let args = ''

if (framework === 'next') {
  args = '--hostname 0.0.0.0 -p ' + port
} else if (framework === 'vite' || framework === 'astro') {
  args = '--host 0.0.0.0 --port ' + port
}

let command = ''

if (framework === 'expo') {
  command =
    'CI=1 PORT=' +
    port +
    ' npx expo start --web --non-interactive --host lan --port ' +
    port
} else {
  const baseCommand = buildRunCommand(packageManager, previewScript, args)
  command =
    'CI=1 HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=' + port + ' ' + baseCommand
}

process.stdout.write(command)
NODE
)

printf "Detected package manager: %s\\nDetected framework: %s\\nUsing preview script: %s\\nStarting command: %s\\n\\n" "$PACKAGE_MANAGER" "$FRAMEWORK" "$PREVIEW_SCRIPT" "$PREVIEW_START_COMMAND" > ${previewLogPath}
nohup sh -lc "$PREVIEW_START_COMMAND" >> ${previewLogPath} 2>&1 &

echo "Started preview script '$PREVIEW_SCRIPT' with $PACKAGE_MANAGER for app preview on port ${port}."
`.trim()
}

function getAppPreviewLogPath(workspacePath: string, port: number) {
  return pathPosix.join(
    workspacePath,
    '.buddypie/logs',
    `app-preview-${port}.log`,
  )
}

async function isPortListeningInSandbox(
  sandbox: Sandbox,
  workspacePath: string,
  port: number,
) {
  const response = (await sandbox.process.executeCommand(
    `node -e ${quoteShellArg(buildPortProbeScript())} ${port}`,
    workspacePath,
    undefined,
    APP_PREVIEW_PORT_PROBE_TIMEOUT_SECONDS,
  )) as ExecuteCommandResponse

  return response.exitCode === 0
}

function summarizeCommandOutput(output: string) {
  const trimmed = output.trim()

  if (!trimmed) {
    return 'No command output was captured.'
  }

  const collapsedWhitespace = trimmed.replace(/\s+/g, ' ')
  return collapsedWhitespace.length > 400
    ? `${collapsedWhitespace.slice(0, 397)}...`
    : collapsedWhitespace
}

function parseSeededSessionPayload(stdout: string) {
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

function parseJsonCommandOutput<T>(response: ExecuteCommandResponse) {
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

function buildManagedInstructionsContent(
  preset: OpenCodeAgentPreset,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
) {
  const runtimeInstructions =
    buildWorkspaceBootstrapInstructions(runtimeContext)
  return runtimeInstructions
    ? `${preset.instructionsMd}\n\n${runtimeInstructions}`
    : preset.instructionsMd
}

function buildInitialPromptContent(
  initialPrompt: string,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
) {
  const runtimePromptPrefix =
    buildWorkspaceBootstrapPromptPrefix(runtimeContext)
  return runtimePromptPrefix
    ? `${runtimePromptPrefix}\n\n${initialPrompt}`
    : initialPrompt
}

function buildSkillPermissions(
  preset: OpenCodeAgentPreset,
): Record<string, OpenCodeSkillPermission> {
  const permissions: Record<string, OpenCodeSkillPermission> = {
    '*': 'deny',
  }

  for (const skill of preset.skills) {
    permissions[skill.id] = skill.permission ?? 'allow'
  }

  return permissions
}

function buildOpenCodeConfig(
  preset: OpenCodeAgentPreset,
  previewUrlPattern: string,
) {
  const skillPermissions = buildSkillPermissions(preset)
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
    permission: {
      skill: skillPermissions,
    },
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
        permission: {
          skill: skillPermissions,
        },
      },
    },
    ...(Object.keys(preset.mcp).length > 0 ? { mcp: preset.mcp } : {}),
  })
}

function buildLaunchEnvironment(
  preset: OpenCodeAgentPreset,
  githubToken?: string | null,
): LaunchEnvironment {
  const environment: LaunchEnvironment = {}

  for (const envName of preset.requiredEnv) {
    environment[envName] = getRequiredServerEnv(envName)

    for (const aliasName of SHARED_ENV_FALLBACKS[envName] ?? []) {
      environment[aliasName] = environment[envName]
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

  if (githubToken) {
    environment.GITHUB_TOKEN = githubToken
  }

  return environment
}

export function resolveOpenCodeLaunchConfig(args: {
  agentPresetId: string
  agentProvider?: string
  agentModel?: string
  githubToken?: string | null
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
    launchEnvironment: buildLaunchEnvironment(preset, args.githubToken),
  }
}

async function ensureRemoteDirectory(sandbox: Sandbox, remotePath: string) {
  await sandbox.process.executeCommand(
    `mkdir -p ${quoteShellArg(remotePath)}`,
    undefined,
    undefined,
    30,
  )
}

async function uploadTextFile(
  sandbox: Sandbox,
  remotePath: string,
  content: string,
) {
  await ensureRemoteDirectory(sandbox, pathPosix.dirname(remotePath))
  await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), remotePath)
}

async function downloadTextFile(sandbox: Sandbox, remotePath: string) {
  try {
    const file = await sandbox.fs.downloadFile(remotePath)
    return Buffer.isBuffer(file) ? file.toString('utf8') : null
  } catch {
    return null
  }
}

async function ensureWorkspaceGitignoreDirectory(
  sandbox: Sandbox,
  workspacePath: string,
  directory: string,
) {
  const gitignorePath = pathPosix.join(workspacePath, '.gitignore')
  const existingContent = (await downloadTextFile(sandbox, gitignorePath)) ?? ''
  const nextContent = ensureDirectoryInGitignore(existingContent, directory)

  if (nextContent !== existingContent) {
    await uploadTextFile(sandbox, gitignorePath, nextContent)
  }
}

async function inspectDocsAppPaths(args: {
  sandbox: Sandbox
  workspacePath: string
  preferredDocsPath: string
  fallbackDocsPath: string
}) {
  const inspectScript = `
const fs = require('node:fs')
const path = require('node:path')

function inspect(targetPath) {
  const resolvedPath = path.resolve(process.cwd(), targetPath)
  const exists = fs.existsSync(resolvedPath)

  if (!exists) {
    return { exists: false, looksLikeFumadocs: false }
  }

  const packageJsonPath = path.join(resolvedPath, 'package.json')
  let looksLikeFumadocs = false

  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      }
      looksLikeFumadocs = [
        'fumadocs-core',
        'fumadocs-mdx',
        'fumadocs-ui',
      ].some((name) => typeof deps[name] === 'string')
    } catch {}
  }

  if (!looksLikeFumadocs) {
    looksLikeFumadocs =
      fs.existsSync(path.join(resolvedPath, 'source.config.ts')) ||
      fs.existsSync(path.join(resolvedPath, 'source.config.js')) ||
      fs.existsSync(path.join(resolvedPath, 'content', 'docs'))
  }

  return { exists, looksLikeFumadocs }
}

const preferred = inspect(process.argv[1])
const fallback = inspect(process.argv[2])

process.stdout.write(
  JSON.stringify({
    preferredPathExists: preferred.exists,
    preferredPathLooksLikeFumadocs: preferred.looksLikeFumadocs,
    fallbackPathExists: fallback.exists,
    fallbackPathLooksLikeFumadocs: fallback.looksLikeFumadocs,
  }),
)
`.trim()
  const response = (await args.sandbox.process.executeCommand(
    `node -e ${quoteShellArg(inspectScript)} ${quoteShellArg(args.preferredDocsPath)} ${quoteShellArg(args.fallbackDocsPath)}`,
    args.workspacePath,
    undefined,
    30,
  )) as ExecuteCommandResponse

  return parseJsonCommandOutput<DocsAppPathInspection>(response)
}

async function ensureReferenceRepository(args: {
  sandbox: Sandbox
  workspacePath: string
  repoUrl: string
  branch: string
  relativePath: string
}) {
  const remotePath = pathPosix.join(args.workspacePath, args.relativePath)
  const inspectScript = `
const fs = require('node:fs')
const path = require('node:path')
const target = path.resolve(process.cwd(), process.argv[1])
process.stdout.write(
  JSON.stringify({
    exists: fs.existsSync(target),
    isGitRepo: fs.existsSync(path.join(target, '.git')),
  }),
)
`.trim()
  const inspectResponse = (await args.sandbox.process.executeCommand(
    `node -e ${quoteShellArg(inspectScript)} ${quoteShellArg(args.relativePath)}`,
    args.workspacePath,
    undefined,
    30,
  )) as ExecuteCommandResponse
  const state = parseJsonCommandOutput<{
    exists: boolean
    isGitRepo: boolean
  }>(inspectResponse)

  if (state.exists && !state.isGitRepo) {
    throw new Error(
      `Cannot prepare '${args.relativePath}' because that path already exists and is not a Git repository.`,
    )
  }

  if (!state.exists) {
    await ensureRemoteDirectory(args.sandbox, pathPosix.dirname(remotePath))
    await args.sandbox.git.clone(args.repoUrl, remotePath, args.branch)
  }

  return remotePath
}

async function scaffoldDocsApp(args: {
  sandbox: Sandbox
  workspacePath: string
  docsAppPath: string
  docsTemplate: string
  packageManager: string
}) {
  const scaffoldCommand = `
set -e
export PATH="$HOME/.bun/bin:$PATH"

BUN_BIN=$(command -v bun || true)

if [ -z "$BUN_BIN" ]; then
  echo "Bun is required in the Daytona sandbox to scaffold the docs app."
  exit 1
fi

CI=1 "$BUN_BIN" x create-fumadocs-app ${quoteShellArg(args.docsAppPath)} --template ${quoteShellArg(args.docsTemplate)} --pm ${quoteShellArg(args.packageManager)} --install --no-git
`.trim()
  const response = (await args.sandbox.process.executeCommand(
    scaffoldCommand,
    args.workspacePath,
    undefined,
    300,
  )) as ExecuteCommandResponse

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `Fumadocs scaffolding failed: ${summarizeCommandOutput(
        getCommandStdout(response),
      )}`,
    )
  }
}

async function bootstrapWorkspace(args: {
  sandbox: Sandbox
  workspacePath: string
  preset: OpenCodeAgentPreset
}): Promise<WorkspaceBootstrapResult> {
  const bootstrap = args.preset.workspaceBootstrap

  if (!bootstrap) {
    return {}
  }

  if (bootstrap.kind !== 'fumadocs-docs-app') {
    return {}
  }

  const sourceRepoPath = await ensureReferenceRepository({
    sandbox: args.sandbox,
    workspacePath: args.workspacePath,
    repoUrl: bootstrap.sourceRepoUrl,
    branch: bootstrap.sourceRepoBranch,
    relativePath: bootstrap.sourceRepoPath,
  })

  await ensureWorkspaceGitignoreDirectory(
    args.sandbox,
    args.workspacePath,
    'sources',
  )

  const inspection = await inspectDocsAppPaths({
    sandbox: args.sandbox,
    workspacePath: args.workspacePath,
    preferredDocsPath: bootstrap.preferredDocsPath,
    fallbackDocsPath: bootstrap.fallbackDocsPath,
  })
  const docsApp = resolveDocsAppPath(bootstrap, inspection)
  const docsAppPath = pathPosix.join(args.workspacePath, docsApp.docsAppPath)

  if (docsApp.shouldScaffold) {
    await scaffoldDocsApp({
      sandbox: args.sandbox,
      workspacePath: args.workspacePath,
      docsAppPath: docsApp.docsAppPath,
      docsTemplate: bootstrap.docsTemplate,
      packageManager: bootstrap.packageManager,
    })
  }

  return {
    runtimeContext: {
      repoRoot: args.workspacePath,
      sourceRepoUrl: bootstrap.sourceRepoUrl,
      sourceRepoBranch: bootstrap.sourceRepoBranch,
      sourceRepoPath,
      docsAppPath,
      packageManager: bootstrap.packageManager,
    },
  }
}

async function hideManagedFilesFromGitStatus(
  sandbox: Sandbox,
  workspacePath: string,
  preset: OpenCodeAgentPreset,
) {
  const excludePath = pathPosix.join(workspacePath, '.git/info/exclude')
  const patterns = [
    '.buddypie/',
    ...preset.skills.map((skill) => `.opencode/skills/${skill.id}/`),
  ]
  const script = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const target = process.argv[1]',
    "const patterns = JSON.parse(process.env.BUDDYPIE_EXCLUDES ?? '[]')",
    "let existing = ''",
    "try { existing = fs.readFileSync(target, 'utf8') } catch {}",
    'const lines = new Set(existing.split(/\\r?\\n/).filter(Boolean))',
    'for (const pattern of patterns) lines.add(pattern)',
    'fs.mkdirSync(path.dirname(target), { recursive: true })',
    "fs.writeFileSync(target, `${Array.from(lines).join('\\n')}\\n`, 'utf8')",
  ].join('; ')

  await sandbox.process.executeCommand(
    `node -e ${quoteShellArg(script)} ${quoteShellArg(excludePath)}`,
    undefined,
    {
      BUDDYPIE_EXCLUDES: JSON.stringify(patterns),
    },
    30,
  )
}

async function writeManagedWorkspaceFiles(
  sandbox: Sandbox,
  workspacePath: string,
  preset: OpenCodeAgentPreset,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
) {
  const instructionsPath = pathPosix.join(
    workspacePath,
    '.buddypie/opencode/AGENTS.md',
  )
  await uploadTextFile(
    sandbox,
    instructionsPath,
    buildManagedInstructionsContent(preset, runtimeContext),
  )

  for (const skill of preset.skills) {
    const skillPath = pathPosix.join(
      workspacePath,
      '.opencode/skills',
      skill.id,
      'SKILL.md',
    )

    await uploadTextFile(sandbox, skillPath, skill.content)
  }

  await hideManagedFilesFromGitStatus(sandbox, workspacePath, preset)
}

async function cloneRepository(args: {
  sandbox: Sandbox
  repoUrl: string
  branch?: string
  agentPresetId: OpenCodeAgentPresetId
  initialPrompt?: string
  githubToken?: string | null
}) {
  const normalized = normalizeSandboxInput({
    repoUrl: args.repoUrl,
    branch: args.branch,
    agentPresetId: args.agentPresetId,
    initialPrompt: args.initialPrompt,
  })
  const workspacePath = getWorkspacePath(normalized.repoName)

  try {
    if (normalized.repoProvider === 'github' && args.githubToken) {
      await args.sandbox.git.clone(
        normalized.repoUrl,
        workspacePath,
        normalized.branch,
        undefined,
        'git',
        args.githubToken,
      )
    } else {
      await args.sandbox.git.clone(
        normalized.repoUrl,
        workspacePath,
        normalized.branch,
      )
    }
  } catch (error) {
    if (normalized.repoProvider === 'github' && !args.githubToken) {
      throw new Error(
        'Cloning the repository failed. If it is private, connect GitHub in Clerk and grant repo access before retrying.',
      )
    }

    throw error
  }

  return {
    ...normalized,
    workspacePath,
  }
}

async function startOpencodeWeb(args: {
  sandbox: Sandbox
  workspacePath: string
  preset: OpenCodeAgentPreset
  launchEnvironment: LaunchEnvironment
}): Promise<{ previewUrl: string; previewUrlPattern: string }> {
  const previewLink = await args.sandbox.getPreviewLink(OPENCODE_PORT)
  const previewUrlPattern = (
    await args.sandbox.getPreviewLink(1234)
  ).url.replace(/1234/, '{PORT}')
  const opencodeConfig = buildOpenCodeConfig(args.preset, previewUrlPattern)
  const sessionId = `opencode-web-${Date.now()}`
  const envVars = [
    injectEnvVar('OPENCODE_CONFIG_CONTENT', opencodeConfig),
    injectEnvVar('OPENCODE_DISABLE_CLAUDE_CODE', '1'),
    ...Object.entries(args.launchEnvironment).map(([name, value]) =>
      injectEnvVar(name, value),
    ),
  ].join(' ')

  await args.sandbox.process.createSession(sessionId)
  const command = await args.sandbox.process.executeSessionCommand(sessionId, {
    command: `cd ${quoteShellArg(args.workspacePath)} && ${envVars} opencode web --port ${OPENCODE_PORT}`,
    runAsync: true,
  })

  if (!command.cmdId) {
    throw new Error('Failed to start OpenCode inside the sandbox.')
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    void args.sandbox.process.getSessionCommandLogs(
      sessionId,
      command.cmdId,
      (stdout) => {
        if (
          stdout.includes(`127.0.0.1:${OPENCODE_PORT}`) ||
          stdout.includes('Web interface:')
        ) {
          finish()
        }
      },
      () => {},
    )

    setTimeout(finish, READY_TIMEOUT_MS)
  })

  return {
    previewUrl: previewLink.url,
    previewUrlPattern,
  }
}

async function seedInitialPrompt(args: {
  sandbox: Sandbox
  workspacePath: string
  repoName: string
  preset: OpenCodeAgentPreset
  initialPrompt: string
}) {
  const seedScript = `
;(async () => {
  const baseUrl = 'http://127.0.0.1:${OPENCODE_PORT}'
  const initialPrompt = process.env.BUDDYPIE_INITIAL_PROMPT?.trim() ?? ''
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitForApi = async () => {
    const timeoutAt = Date.now() + 45_000

    while (Date.now() < timeoutAt) {
      try {
        const response = await fetch(\`\${baseUrl}/session/status\`)
        if (response.ok) {
          return
        }
      } catch {}

      await wait(750)
    }

    throw new Error('OpenCode API did not become ready in time.')
  }
  const waitForAssistantMessage = async (sessionId) => {
    if (!initialPrompt) {
      return
    }

    const timeoutAt = Date.now() + 15_000

    while (Date.now() < timeoutAt) {
      const response = await fetch(
        \`\${baseUrl}/session/\${sessionId}/message?limit=20\`,
      )

      if (response.ok) {
        const messages = await response.json()
        const assistant = Array.isArray(messages)
          ? messages.find((message) => message?.info?.role === 'assistant')
          : undefined

        if (assistant?.info?.error) {
          const detail =
            assistant.info.error.message ||
            assistant.info.error.data?.message ||
            JSON.stringify(assistant.info.error)
          throw new Error(\`OpenCode prompt failed: \${detail}\`)
        }

        if (assistant) {
          return
        }
      }

      await wait(500)
    }
  }

  await waitForApi()

  const sessionResponse = await fetch(\`\${baseUrl}/session\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: process.env.BUDDYPIE_SESSION_TITLE }),
  })
  if (!sessionResponse.ok) {
    throw new Error(\`OpenCode session creation failed: \${sessionResponse.status} \${await sessionResponse.text()}\`)
  }
  const session = await sessionResponse.json()

  if (initialPrompt) {
    const promptResponse = await fetch(\`\${baseUrl}/session/\${session.id}/prompt_async\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: process.env.BUDDYPIE_AGENT_ID,
        parts: [{ type: 'text', text: initialPrompt }],
      }),
    })
    if (!promptResponse.ok && promptResponse.status !== 204) {
      throw new Error(\`OpenCode prompt injection failed: \${promptResponse.status} \${await promptResponse.text()}\`)
    }

    await waitForAssistantMessage(session.id)
  }

  process.stdout.write('${SEEDED_SESSION_PAYLOAD_MARKER}' + JSON.stringify({ sessionId: session.id }))
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
`.trim()
  const response = (await args.sandbox.process.executeCommand(
    `node -e ${quoteShellArg(seedScript)}`,
    args.workspacePath,
    {
      BUDDYPIE_AGENT_ID: args.preset.id,
      BUDDYPIE_INITIAL_PROMPT: args.initialPrompt,
      BUDDYPIE_SESSION_TITLE: `${args.repoName} - ${args.preset.label}`,
    },
    90,
  )) as ExecuteCommandResponse
  const stdout = getCommandStdout(response).trim()

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `OpenCode prompt seeding failed: ${summarizeCommandOutput(stdout)}`,
    )
  }

  if (!stdout) {
    throw new Error('OpenCode did not return a seeded session id.')
  }

  const payload = parseSeededSessionPayload(stdout)

  if (!payload.sessionId) {
    throw new Error('OpenCode did not create a valid seeded session.')
  }

  return payload.sessionId
}

export async function createOpenCodeSandbox(args: {
  repoUrl: string
  branch?: string
  agentPresetId: string
  agentProvider?: string
  agentModel?: string
  initialPrompt?: string
  githubToken?: string | null
}) {
  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const { preset, launchEnvironment } = resolveOpenCodeLaunchConfig({
    agentPresetId: args.agentPresetId,
    agentProvider: args.agentProvider,
    agentModel: args.agentModel,
    githubToken: args.githubToken,
  })
  let sandbox: Sandbox | undefined

  try {
    sandbox = await daytona.create({
      public: true,
      autoStopInterval: 30,
    })

    const repo = await cloneRepository({
      sandbox,
      repoUrl: args.repoUrl,
      branch: args.branch,
      agentPresetId: preset.id,
      initialPrompt: args.initialPrompt,
      githubToken: args.githubToken,
    })
    const workspaceBootstrap = await bootstrapWorkspace({
      sandbox,
      workspacePath: repo.workspacePath,
      preset,
    })
    const seededInitialPrompt = buildInitialPromptContent(
      repo.initialPrompt,
      workspaceBootstrap.runtimeContext,
    )

    await writeManagedWorkspaceFiles(
      sandbox,
      repo.workspacePath,
      preset,
      workspaceBootstrap.runtimeContext,
    )
    await sandbox.process.executeCommand(
      `npm i -g opencode-ai@${OPENCODE_VERSION}`,
      undefined,
      undefined,
      300,
    )

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
  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(daytonaSandboxId)
  await sandbox.delete()
}

export async function ensureSandboxAppPreviewServer(args: {
  daytonaSandboxId: string
  workspacePath: string
  port: number
}) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('Choose a valid preview port between 1 and 65535.')
  }

  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(args.daytonaSandboxId)

  if (await isPortListeningInSandbox(sandbox, args.workspacePath, args.port)) {
    const previewLink = await sandbox.getPreviewLink(args.port)

    return {
      status: 'already-running' as const,
      port: args.port,
      previewUrl: previewLink.url,
    }
  }

  const response = (await sandbox.process.executeCommand(
    buildPreviewStartCommand(args.port),
    args.workspacePath,
    undefined,
    APP_PREVIEW_START_TIMEOUT_SECONDS,
  )) as ExecuteCommandResponse

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `Could not auto-start the app preview server: ${summarizeCommandOutput(getCommandStdout(response))}`,
    )
  }

  const bootDeadline = Date.now() + APP_PREVIEW_BOOT_TIMEOUT_MS

  while (Date.now() < bootDeadline) {
    if (
      await isPortListeningInSandbox(sandbox, args.workspacePath, args.port)
    ) {
      const previewLink = await sandbox.getPreviewLink(args.port)

      return {
        status: 'started' as const,
        port: args.port,
        previewUrl: previewLink.url,
      }
    }

    await sleep(APP_PREVIEW_BOOT_POLL_INTERVAL_MS)
  }

  throw new Error(
    `The preview command started but port ${args.port} is still unreachable. Check .buddypie/logs/app-preview-${args.port}.log in the sandbox.`,
  )
}

export async function getSandboxAppPreviewStatus(args: {
  daytonaSandboxId: string
  workspacePath: string
  port: number
}) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('Choose a valid preview port between 1 and 65535.')
  }

  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(args.daytonaSandboxId)

  if (
    !(await isPortListeningInSandbox(sandbox, args.workspacePath, args.port))
  ) {
    return {
      status: 'not-running' as const,
      port: args.port,
    }
  }

  const previewLink = await sandbox.getPreviewLink(args.port)

  return {
    status: 'already-running' as const,
    port: args.port,
    previewUrl: previewLink.url,
  }
}

export async function getSandboxAppPreviewCommandSuggestion(args: {
  daytonaSandboxId: string
  workspacePath: string
  port: number
}) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('Choose a valid preview port between 1 and 65535.')
  }

  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(args.daytonaSandboxId)
  const response = (await sandbox.process.executeCommand(
    `
node - ${args.port} <<'NODE'
const fs = require('node:fs')
const port = Number(process.argv[2] || process.argv[1] || 3000)

if (!fs.existsSync('package.json')) {
  console.error('No package.json found in workspace.')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const scripts = pkg.scripts ?? {}
const deps = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
}
const packageManagerField =
  typeof pkg.packageManager === 'string' ? pkg.packageManager : ''
const packageManagerName = packageManagerField.split('@')[0]
const hasFile = (name) => fs.existsSync(name)
const scriptPreference = ['dev:web', 'dev', 'start', 'web', 'server']
const previewScript =
  scriptPreference.find((name) => typeof scripts[name] === 'string') ?? ''
const previewScriptCommand =
  typeof scripts[previewScript] === 'string' ? scripts[previewScript] : ''

if (!previewScript) {
  console.error(
    'No supported preview script found in package.json. Expected one of dev:web, dev, start, web, or server.',
  )
  process.exit(1)
}

let packageManager = 'npm'

if (
  packageManagerName === 'bun' ||
  hasFile('bun.lock') ||
  hasFile('bun.lockb')
) {
  packageManager = 'bun'
} else if (
  packageManagerName === 'pnpm' ||
  hasFile('pnpm-lock.yaml')
) {
  packageManager = 'pnpm'
} else if (
  packageManagerName === 'yarn' ||
  hasFile('yarn.lock')
) {
  packageManager = 'yarn'
}

let framework = 'generic'
const script = previewScriptCommand.toLowerCase()

if (deps.expo || script.includes('expo ')) {
  framework = 'expo'
} else if (deps.next || script.includes('next ')) {
  framework = 'next'
} else if (
  deps.astro ||
  script.includes('astro ') ||
  script.startsWith('astro')
) {
  framework = 'astro'
} else if (
  deps.vite ||
  deps['@sveltejs/kit'] ||
  deps['solid-start'] ||
  script.includes('vite ') ||
  script.startsWith('vite')
) {
  framework = 'vite'
} else if (
  deps['react-scripts'] ||
  script.includes('react-scripts ')
) {
  framework = 'cra'
}

function buildRunCommand(pm, scriptName, args) {
  if (pm === 'yarn') {
    return args ? 'yarn ' + scriptName + ' ' + args : 'yarn ' + scriptName
  }

  if (pm === 'bun') {
    return args
      ? 'export PATH="$HOME/.bun/bin:$PATH" && $HOME/.bun/bin/bun run ' +
          scriptName +
          ' ' +
          args
      : 'export PATH="$HOME/.bun/bin:$PATH" && $HOME/.bun/bin/bun run ' + scriptName
  }

  const baseCommand = pm + ' run ' + scriptName
  return args ? baseCommand + ' -- ' + args : baseCommand
}

let commandArgs = ''

if (framework === 'next') {
  commandArgs = '--hostname 0.0.0.0 -p ' + port
} else if (framework === 'vite' || framework === 'astro') {
  commandArgs = '--host 0.0.0.0 --port ' + port
}

const command =
  framework === 'expo'
    ? 'CI=1 PORT=' +
      port +
      ' npx expo start --web --non-interactive --host lan --port ' +
      port
    : 'CI=1 HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=' +
      port +
      ' ' +
      buildRunCommand(packageManager, previewScript, commandArgs)

process.stdout.write(
  JSON.stringify({
    command,
    framework,
    packageManager,
    previewScript,
  }),
)
NODE
    `.trim(),
    args.workspacePath,
    undefined,
    30,
  )) as ExecuteCommandResponse

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `Could not determine a preview command for this repo: ${summarizeCommandOutput(getCommandStdout(response))}`,
    )
  }

  const stdout = getCommandStdout(response).trim()

  if (!stdout) {
    throw new Error('Could not determine a preview command for this repo.')
  }

  let payload: {
    command?: string
    framework?: string
    packageManager?: string
    previewScript?: string
  }

  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new Error(
      `Could not parse the preview command suggestion: ${summarizeCommandOutput(stdout)}`,
    )
  }

  if (!payload.command || !payload.packageManager || !payload.previewScript) {
    throw new Error('The preview command suggestion was incomplete.')
  }

  return {
    command: `cd ${quoteShellArg(args.workspacePath)} && ${payload.command}`,
    framework: payload.framework ?? 'generic',
    packageManager: payload.packageManager,
    previewScript: payload.previewScript,
    workspacePath: args.workspacePath,
  }
}

export async function getSandboxAppPreviewLogTail(args: {
  daytonaSandboxId: string
  workspacePath: string
  port: number
  lines?: number
}) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('Choose a valid preview port between 1 and 65535.')
  }

  const lines =
    Number.isInteger(args.lines) && (args.lines ?? 0) > 0
      ? Math.min(args.lines ?? APP_PREVIEW_LOG_TAIL_LINES, 1000)
      : APP_PREVIEW_LOG_TAIL_LINES
  const logPath = getAppPreviewLogPath(args.workspacePath, args.port)

  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(args.daytonaSandboxId)
  const response = (await sandbox.process.executeCommand(
    [
      `if [ -f ${quoteShellArg(logPath)} ]; then`,
      `  tail -n ${lines} ${quoteShellArg(logPath)}`,
      'else',
      `  echo "Log file not found: ${logPath}"`,
      'fi',
    ].join('\n'),
    args.workspacePath,
    undefined,
    30,
  )) as ExecuteCommandResponse

  return {
    port: args.port,
    output: getCommandStdout(response).trim(),
    logPath,
  }
}

export async function createSandboxSshAccessCommand(args: {
  daytonaSandboxId: string
  expiresInMinutes?: number
}) {
  const expiresInMinutes =
    Number.isInteger(args.expiresInMinutes) && (args.expiresInMinutes ?? 0) > 0
      ? Math.min(args.expiresInMinutes ?? 60, 24 * 60)
      : 60

  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(args.daytonaSandboxId)
  const sshAccess = await sandbox.createSshAccess(expiresInMinutes)

  return {
    sshCommand: sshAccess.sshCommand,
    expiresAt: sshAccess.expiresAt,
  }
}

export async function getSandboxPortPreviewUrl(args: {
  daytonaSandboxId: string
  port: number
}) {
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error('Choose a valid preview port between 1 and 65535.')
  }

  const daytona = new Daytona({
    apiKey: getRequiredDaytonaApiKey(),
    apiUrl: getDaytonaApiUrl(),
  })
  const sandbox = await daytona.get(args.daytonaSandboxId)
  const previewLink = await sandbox.getPreviewLink(args.port)

  return {
    port: args.port,
    previewUrl: previewLink.url,
  }
}
