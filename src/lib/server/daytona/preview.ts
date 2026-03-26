import { posix as pathPosix } from 'node:path'
import type { Sandbox } from '@daytonaio/sdk'
import type { OpenCodeAgentPreset } from '~/lib/opencode/presets'
import { getOpenCodeAgentPreset } from '~/lib/opencode/presets'
import { resolveDocsAppPath } from '~/lib/opencode/workspace-bootstrap'
import {
  APP_PREVIEW_BOOT_POLL_INTERVAL_MS,
  APP_PREVIEW_BOOT_TIMEOUT_MS,
  APP_PREVIEW_LOG_TAIL_LINES,
  APP_PREVIEW_MAX_PORT,
  APP_PREVIEW_MIN_PORT,
  APP_PREVIEW_PORT_PROBE_TIMEOUT_SECONDS,
  APP_PREVIEW_START_TIMEOUT_SECONDS,
  createDaytonaClient,
  getCommandStdout,
  quoteShellArg,
  sleep,
  summarizeCommandOutput,
  type ExecuteCommandResponse,
  type PreviewCommandMetadata,
  type PreviewTargetResolution,
} from './shared'
import { inspectDocsAppPaths } from './workspace'

const PREVIEW_SCRIPT_PREFERENCE = [
  'dev:web',
  'dev',
  'preview',
  'start',
  'web',
  'server',
] as const

export function isValidAppPreviewPort(port: number) {
  return (
    Number.isInteger(port) &&
    port >= APP_PREVIEW_MIN_PORT &&
    port <= APP_PREVIEW_MAX_PORT
  )
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

export function resolveLaunchPreviewAppPath(args: {
  preset: OpenCodeAgentPreset
  workspacePath: string
  runtimeContext?: import('~/lib/opencode/workspace-bootstrap').WorkspaceBootstrapRuntimeContext
}) {
  return resolvePreviewAppPath({
    workspacePath: args.workspacePath,
    agentPresetId: args.preset.id,
    docsAppPath: args.runtimeContext?.docsAppPath,
  })
}

export function resolvePreviewAppPath(args: {
  workspacePath: string
  previewAppPath?: string
  agentPresetId?: string
  docsAppPath?: string
}) {
  const persistedPreviewAppPath = args.previewAppPath?.trim()

  if (persistedPreviewAppPath) {
    return persistedPreviewAppPath
  }

  if (args.agentPresetId === 'docs-writer' && args.docsAppPath) {
    return args.docsAppPath
  }

  return args.workspacePath
}

export function selectPreviewScript(scripts: Record<string, unknown>) {
  return (
    PREVIEW_SCRIPT_PREFERENCE.find(
      (name) => typeof scripts[name] === 'string',
    ) ?? ''
  )
}

function buildPreviewMetadataScript() {
  return `
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
const scriptPreference = ${JSON.stringify([...PREVIEW_SCRIPT_PREFERENCE])}
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
`.trim()
}

export function buildPreviewCommand(args: {
  packageManager: string
  framework: string
  previewScript: string
  port: number
}) {
  const { packageManager, framework, previewScript, port } = args

  function buildRunCommand(
    pm: string,
    scriptName: string,
    commandArgs: string,
  ) {
    if (pm === 'yarn') {
      return commandArgs
        ? `yarn ${scriptName} ${commandArgs}`
        : `yarn ${scriptName}`
    }

    if (pm === 'bun') {
      return commandArgs
        ? `export PATH="$HOME/.bun/bin:$PATH" && $HOME/.bun/bin/bun run ${scriptName} ${commandArgs}`
        : `export PATH="$HOME/.bun/bin:$PATH" && $HOME/.bun/bin/bun run ${scriptName}`
    }

    const baseCommand = `${pm} run ${scriptName}`
    return commandArgs ? `${baseCommand} -- ${commandArgs}` : baseCommand
  }

  let commandArgs = ''

  if (framework === 'next') {
    commandArgs = `--hostname 0.0.0.0 -p ${port}`
  } else if (framework === 'vite' || framework === 'astro') {
    commandArgs = `--host 0.0.0.0 --port ${port}`
  }

  if (framework === 'expo') {
    return `CI=1 PORT=${port} npx expo start --web --non-interactive --host lan --port ${port}`
  }

  return `CI=1 HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=${port} ${buildRunCommand(packageManager, previewScript, commandArgs)}`
}

function buildPreviewScriptMissingMessage() {
  return `No supported preview script found in package.json. Expected one of ${PREVIEW_SCRIPT_PREFERENCE.join(', ')}.`
}

export function buildPreviewCommandSuggestion(args: {
  workspacePath: string
  previewAppPath: string
  metadata: PreviewCommandMetadata
  port: number
}) {
  return {
    command: `cd ${quoteShellArg(args.previewAppPath)} && ${buildPreviewCommand(
      {
        packageManager: args.metadata.packageManager,
        framework: args.metadata.framework,
        previewScript: args.metadata.previewScript,
        port: args.port,
      },
    )}`,
    framework: args.metadata.framework,
    packageManager: args.metadata.packageManager,
    previewScript: args.metadata.previewScript,
    workspacePath: args.workspacePath,
    previewAppPath: args.previewAppPath,
  }
}

function buildPreviewStartCommand(args: {
  port: number
  workspacePath: string
  previewAppPath: string
}) {
  const previewLogPath = getAppPreviewLogPath(args.workspacePath, args.port)

  return `
set -e
mkdir -p ${quoteShellArg(pathPosix.dirname(previewLogPath))}
cd ${quoteShellArg(args.previewAppPath)}

if [ ! -f package.json ]; then
  echo "No package.json found in preview target."
  exit 1
fi

PREVIEW_METADATA=$(node <<'NODE'
${buildPreviewMetadataScript()}
NODE
)

PREVIEW_SCRIPT=$(node -e "const meta=JSON.parse(process.argv[1]);process.stdout.write(meta.previewScript||'')" "$PREVIEW_METADATA")

if [ -z "$PREVIEW_SCRIPT" ]; then
  echo ${quoteShellArg(buildPreviewScriptMissingMessage())}
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

PREVIEW_START_COMMAND=${quoteShellArg(
    buildPreviewCommand({
      packageManager: '__PACKAGE_MANAGER__',
      framework: '__FRAMEWORK__',
      previewScript: '__PREVIEW_SCRIPT__',
      port: args.port,
    }),
  )}
PREVIEW_START_COMMAND=$(printf '%s' "$PREVIEW_START_COMMAND" | sed "s/__PACKAGE_MANAGER__/$PACKAGE_MANAGER/g" | sed "s/__FRAMEWORK__/$FRAMEWORK/g" | sed "s/__PREVIEW_SCRIPT__/$PREVIEW_SCRIPT/g")

printf "Preview path: %s\\nDetected package manager: %s\\nDetected framework: %s\\nUsing preview script: %s\\nStarting command: %s\\n\\n" ${quoteShellArg(args.previewAppPath)} "$PACKAGE_MANAGER" "$FRAMEWORK" "$PREVIEW_SCRIPT" "$PREVIEW_START_COMMAND" > ${quoteShellArg(previewLogPath)}
nohup sh -lc "$PREVIEW_START_COMMAND" >> ${quoteShellArg(previewLogPath)} 2>&1 &

echo "Started preview script '$PREVIEW_SCRIPT' with $PACKAGE_MANAGER for app preview on port ${args.port}."
`.trim()
}

export function getAppPreviewLogPath(workspacePath: string, port: number) {
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

async function resolveSandboxPreviewTarget(args: {
  sandbox: Sandbox
  workspacePath: string
  previewAppPath?: string
  agentPresetId?: string
}): Promise<PreviewTargetResolution> {
  if (args.previewAppPath?.trim()) {
    return {
      previewAppPath: args.previewAppPath.trim(),
    }
  }

  if (args.agentPresetId === 'docs-writer') {
    const docsPreset = getOpenCodeAgentPreset('docs-writer')
    const bootstrap = docsPreset.workspaceBootstrap

    if (bootstrap?.kind === 'fumadocs-docs-app') {
      try {
        const inspection = await inspectDocsAppPaths({
          sandbox: args.sandbox,
          workspacePath: args.workspacePath,
          preferredDocsPath: bootstrap.preferredDocsPath,
          fallbackDocsPath: bootstrap.fallbackDocsPath,
        })
        const docsApp = resolveDocsAppPath(bootstrap, inspection)

        return {
          previewAppPath: resolvePreviewAppPath({
            workspacePath: args.workspacePath,
            agentPresetId: args.agentPresetId,
            docsAppPath: pathPosix.join(
              args.workspacePath,
              docsApp.docsAppPath,
            ),
          }),
        }
      } catch {
        // Fall back to the repo root when the docs app cannot be derived safely.
      }
    }
  }

  return {
    previewAppPath: resolvePreviewAppPath({
      workspacePath: args.workspacePath,
      agentPresetId: args.agentPresetId,
    }),
  }
}

export async function ensureSandboxAppPreviewServer(args: {
  daytonaSandboxId: string
  workspacePath: string
  previewAppPath?: string
  agentPresetId?: string
  port: number
}) {
  if (!isValidAppPreviewPort(args.port)) {
    throw new Error(
      `Choose a valid preview port between ${APP_PREVIEW_MIN_PORT} and ${APP_PREVIEW_MAX_PORT}.`,
    )
  }

  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const previewTarget = await resolveSandboxPreviewTarget({
    sandbox,
    workspacePath: args.workspacePath,
    previewAppPath: args.previewAppPath,
    agentPresetId: args.agentPresetId,
  })

  if (await isPortListeningInSandbox(sandbox, args.workspacePath, args.port)) {
    const previewLink = await sandbox.getPreviewLink(args.port)

    return {
      status: 'already-running' as const,
      port: args.port,
      previewUrl: previewLink.url,
      previewAppPath: previewTarget.previewAppPath,
    }
  }

  const response = (await sandbox.process.executeCommand(
    buildPreviewStartCommand({
      port: args.port,
      workspacePath: args.workspacePath,
      previewAppPath: previewTarget.previewAppPath,
    }),
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
        previewAppPath: previewTarget.previewAppPath,
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
  previewAppPath?: string
  agentPresetId?: string
  port: number
}) {
  if (!isValidAppPreviewPort(args.port)) {
    throw new Error(
      `Choose a valid preview port between ${APP_PREVIEW_MIN_PORT} and ${APP_PREVIEW_MAX_PORT}.`,
    )
  }

  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const previewTarget = await resolveSandboxPreviewTarget({
    sandbox,
    workspacePath: args.workspacePath,
    previewAppPath: args.previewAppPath,
    agentPresetId: args.agentPresetId,
  })

  if (
    !(await isPortListeningInSandbox(sandbox, args.workspacePath, args.port))
  ) {
    return {
      status: 'not-running' as const,
      port: args.port,
      previewAppPath: previewTarget.previewAppPath,
    }
  }

  const previewLink = await sandbox.getPreviewLink(args.port)

  return {
    status: 'already-running' as const,
    port: args.port,
    previewUrl: previewLink.url,
    previewAppPath: previewTarget.previewAppPath,
  }
}

export async function getSandboxAppPreviewCommandSuggestion(args: {
  daytonaSandboxId: string
  workspacePath: string
  previewAppPath?: string
  agentPresetId?: string
  port: number
}) {
  if (!isValidAppPreviewPort(args.port)) {
    throw new Error(
      `Choose a valid preview port between ${APP_PREVIEW_MIN_PORT} and ${APP_PREVIEW_MAX_PORT}.`,
    )
  }

  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const previewTarget = await resolveSandboxPreviewTarget({
    sandbox,
    workspacePath: args.workspacePath,
    previewAppPath: args.previewAppPath,
    agentPresetId: args.agentPresetId,
  })
  const response = (await sandbox.process.executeCommand(
    `node <<'NODE'
${buildPreviewMetadataScript()}
NODE`.trim(),
    previewTarget.previewAppPath,
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

  let payload: Partial<PreviewCommandMetadata>

  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new Error(
      `Could not parse the preview command suggestion: ${summarizeCommandOutput(stdout)}`,
    )
  }

  if (!payload.packageManager || !payload.previewScript) {
    throw new Error('The preview command suggestion was incomplete.')
  }

  return buildPreviewCommandSuggestion({
    workspacePath: args.workspacePath,
    previewAppPath: previewTarget.previewAppPath,
    metadata: {
      framework: payload.framework ?? 'generic',
      packageManager: payload.packageManager,
      previewScript: payload.previewScript,
    },
    port: args.port,
  })
}

export async function getSandboxAppPreviewLogTail(args: {
  daytonaSandboxId: string
  workspacePath: string
  previewAppPath?: string
  agentPresetId?: string
  port: number
  lines?: number
}) {
  if (!isValidAppPreviewPort(args.port)) {
    throw new Error(
      `Choose a valid preview port between ${APP_PREVIEW_MIN_PORT} and ${APP_PREVIEW_MAX_PORT}.`,
    )
  }

  const lines =
    Number.isInteger(args.lines) && (args.lines ?? 0) > 0
      ? Math.min(args.lines ?? APP_PREVIEW_LOG_TAIL_LINES, 1000)
      : APP_PREVIEW_LOG_TAIL_LINES
  const logPath = getAppPreviewLogPath(args.workspacePath, args.port)

  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const previewTarget = await resolveSandboxPreviewTarget({
    sandbox,
    workspacePath: args.workspacePath,
    previewAppPath: args.previewAppPath,
    agentPresetId: args.agentPresetId,
  })
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
    previewAppPath: previewTarget.previewAppPath,
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

  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
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

  const sandbox = await createDaytonaClient().get(args.daytonaSandboxId)
  const previewLink = await sandbox.getPreviewLink(args.port)

  return {
    port: args.port,
    previewUrl: previewLink.url,
  }
}
