import { posix as pathPosix } from 'node:path'
import type { Sandbox } from '@daytonaio/sdk'
import type {
  OpenCodeAgentPreset,
  OpenCodeAgentPresetId,
} from '~/lib/opencode/presets'
import { getOpenCodeAgentPreset } from '~/lib/opencode/presets'
import {
  ensureDirectoryInGitignore,
  resolveDocsAppPath,
  type DocsAppPathInspection,
  type WorkspaceBootstrapRuntimeContext,
} from '~/lib/opencode/workspace-bootstrap'
import {
  buildSandboxWorkBranchName,
  getWorkspacePath,
  normalizeSandboxInput,
} from '~/lib/sandboxes'
import { buildManagedWorkspaceInstructionsContent } from './launch-config'
import {
  NANSEN_CLI_VERSION,
  OPENCODE_VERSION,
  parseJsonCommandOutput,
  quoteShellArg,
  summarizeCommandOutput,
  type ExecuteCommandResponse,
  type GitHubLaunchAuth,
  type RepositoryRuntimeContext,
  type SandboxGitClient,
  type WorkspaceBootstrapResult,
} from './shared'

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

export async function downloadTextFile(sandbox: Sandbox, remotePath: string) {
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

export async function inspectDocsAppPaths(args: {
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
        response.artifacts?.stdout ?? response.stdout ?? response.result ?? '',
      )}`,
    )
  }
}

export async function bootstrapWorkspace(args: {
  sandbox: Sandbox
  workspacePath: string
  preset: OpenCodeAgentPreset
}): Promise<WorkspaceBootstrapResult> {
  const bootstrap = args.preset.workspaceBootstrap

  if (!bootstrap || bootstrap.kind !== 'fumadocs-docs-app') {
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

export async function writeManagedWorkspaceFiles(
  sandbox: Sandbox,
  workspacePath: string,
  preset: OpenCodeAgentPreset,
  runtimeContext?: WorkspaceBootstrapRuntimeContext,
  repositoryContext?: RepositoryRuntimeContext,
) {
  const instructionsPath = pathPosix.join(
    workspacePath,
    '.buddypie/opencode/AGENTS.md',
  )
  await uploadTextFile(
    sandbox,
    instructionsPath,
    buildManagedWorkspaceInstructionsContent(
      preset,
      runtimeContext,
      repositoryContext,
    ),
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

  if (repositoryContext) {
    await hideManagedFilesFromGitStatus(sandbox, workspacePath, preset)
  }
}

export function buildManagedSandboxToolingInstallCommand(
  preset: OpenCodeAgentPreset,
) {
  const commandLines = [
    'set -e',
    'export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"',
    'NPM_GLOBAL_PREFIX="$HOME/.npm-global"',
    '',
    'BUN_BIN=$(command -v bun || true)',
    'NPM_BIN=$(command -v npm || true)',
    '',
    'if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then',
    '  BUN_BIN="$HOME/.bun/bin/bun"',
    'fi',
    '',
    'if [ -z "$NPM_BIN" ]; then',
    '  echo "npm is required in the Daytona sandbox to install BuddyPie managed tooling."',
    '  exit 1',
    'fi',
    '',
    'mkdir -p "$NPM_GLOBAL_PREFIX/bin"',
    '',
    'if [ -n "$BUN_BIN" ]; then',
    `  if ! "${'$'}BUN_BIN" add -g ${quoteShellArg(`opencode-ai@${OPENCODE_VERSION}`)}; then`,
    '    echo "Bun global install failed for opencode-ai, falling back to npm." >&2',
    `    "${'$'}NPM_BIN" install -g --prefix "${'$'}NPM_GLOBAL_PREFIX" ${quoteShellArg(`opencode-ai@${OPENCODE_VERSION}`)}`,
    '  fi',
    'else',
    `  "${'$'}NPM_BIN" install -g --prefix "${'$'}NPM_GLOBAL_PREFIX" ${quoteShellArg(`opencode-ai@${OPENCODE_VERSION}`)}`,
    'fi',
  ]

  if (preset.id === 'nansen-analyst') {
    commandLines.push(
      '',
      'NPX_BIN=$(command -v npx || true)',
      '',
      'if [ -z "$NPX_BIN" ]; then',
      '  echo "npx is required in the Daytona sandbox to install Nansen skills."',
      '  exit 1',
      'fi',
      '',
      `"${'$'}NPM_BIN" install -g --prefix "${'$'}NPM_GLOBAL_PREFIX" ${quoteShellArg(`nansen-cli@${NANSEN_CLI_VERSION}`)}`,
      `"${'$'}NPX_BIN" --yes skills add ${quoteShellArg('nansen-ai/nansen-cli')}`,
    )
  }

  return commandLines.join('\n')
}

export async function installManagedSandboxTooling(args: {
  sandbox: Sandbox
  workspacePath: string
  preset: OpenCodeAgentPreset
  launchEnvironment?: Record<string, string>
}) {
  const installCommand = buildManagedSandboxToolingInstallCommand(args.preset)
  const response = (await args.sandbox.process.executeCommand(
    installCommand,
    args.workspacePath,
    args.launchEnvironment,
    300,
  )) as ExecuteCommandResponse

  if (response.exitCode !== undefined && response.exitCode !== 0) {
    throw new Error(
      `BuddyPie could not install the managed sandbox tooling: ${summarizeCommandOutput(
        response.artifacts?.stdout ?? response.stdout ?? response.result ?? '',
      )}`,
    )
  }
}

async function cloneRepository(args: {
  sandbox: Sandbox
  repoUrl?: string
  branch?: string
  agentPresetId: OpenCodeAgentPresetId
  initialPrompt?: string
  githubAuth?: GitHubLaunchAuth | null
}) {
  const normalized = normalizeSandboxInput({
    repoUrl: args.repoUrl,
    branch: args.branch,
    agentPresetId: args.agentPresetId,
    initialPrompt: args.initialPrompt,
  })
  const repoUrl = normalized.repoUrl
  const workspacePath = getWorkspacePath(normalized.repoName)

  if (!repoUrl) {
    throw new Error('A repository URL is required to clone this workspace.')
  }

  try {
    if (normalized.repoProvider === 'github' && args.githubAuth?.token) {
      await args.sandbox.git.clone(
        repoUrl,
        workspacePath,
        normalized.branch,
        undefined,
        'git',
        args.githubAuth.token,
      )
    } else {
      await args.sandbox.git.clone(
        repoUrl,
        workspacePath,
        normalized.branch,
      )
    }
  } catch (error) {
    if (normalized.repoProvider === 'github' && !args.githubAuth?.token) {
      throw new Error(
        'Cloning the repository failed. If it is private, connect GitHub in Clerk and grant repo access before retrying.',
      )
    }

    throw error
  }

  const repositoryContext = await isolateSandboxGitBranch({
    git: args.sandbox.git,
    workspacePath,
    repoName: normalized.repoName,
  })

  return {
    ...normalized,
    workspacePath,
    repositoryContext,
  }
}

async function prepareStandaloneWorkspace(args: {
  sandbox: Sandbox
  agentPresetId: OpenCodeAgentPresetId
  initialPrompt?: string
}) {
  const normalized = normalizeSandboxInput({
    agentPresetId: args.agentPresetId,
    initialPrompt: args.initialPrompt,
  })
  const workspacePath = getWorkspacePath(normalized.repoName)

  await ensureRemoteDirectory(args.sandbox, workspacePath)

  return {
    ...normalized,
    workspacePath,
    repositoryContext: undefined,
  }
}

export async function prepareSandboxWorkspace(args: {
  sandbox: Sandbox
  repoUrl?: string
  branch?: string
  preset: OpenCodeAgentPreset
  initialPrompt?: string
  githubAuth?: GitHubLaunchAuth | null
}) {
  if (!args.repoUrl?.trim()) {
    return await prepareStandaloneWorkspace({
      sandbox: args.sandbox,
      agentPresetId: args.preset.id,
      initialPrompt: args.initialPrompt,
    })
  }

  const repo = await cloneRepository({
    sandbox: args.sandbox,
    repoUrl: args.repoUrl,
    branch: args.branch,
    agentPresetId: args.preset.id,
    initialPrompt: args.initialPrompt,
    githubAuth: args.githubAuth,
  })

  return repo
}

export async function isolateSandboxGitBranch(args: {
  git: SandboxGitClient
  workspacePath: string
  repoName: string
}) {
  const initialStatus = await args.git.status(args.workspacePath)
  const baseBranch = initialStatus.currentBranch?.trim()

  if (!baseBranch) {
    throw new Error(
      'Daytona cloned the repository without a current branch, so BuddyPie could not isolate a dedicated work branch.',
    )
  }

  const workBranch = buildSandboxWorkBranchName({
    repoName: args.repoName,
    baseBranch,
  })

  await args.git.createBranch(args.workspacePath, workBranch)
  await args.git.checkoutBranch(args.workspacePath, workBranch)

  const isolatedStatus = await args.git.status(args.workspacePath)

  if (isolatedStatus.currentBranch !== workBranch) {
    throw new Error(
      `BuddyPie expected the isolated branch '${workBranch}', but Daytona reported '${isolatedStatus.currentBranch}'.`,
    )
  }

  await args.git.deleteBranch(args.workspacePath, baseBranch)

  return {
    baseBranch,
    workBranch,
  } satisfies RepositoryRuntimeContext
}

export async function configureGitHubAuthForSandbox(args: {
  sandbox: Sandbox
  workspacePath: string
  githubAuth?: GitHubLaunchAuth | null
}) {
  if (!args.githubAuth?.token) {
    return
  }

  const credentialHelper =
    '!f() { if [ "$1" = get ]; then echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; fi; }; f'
  const commands = [
    `git config --local credential.https://github.com.helper ${quoteShellArg(credentialHelper)}`,
  ]

  if (args.githubAuth.accountLogin) {
    commands.push(
      `git config --local github.user ${quoteShellArg(args.githubAuth.accountLogin)}`,
    )
  }

  if (args.githubAuth.accountName) {
    commands.push(
      `git config --local user.name ${quoteShellArg(args.githubAuth.accountName)}`,
    )
  }

  if (args.githubAuth.accountEmail) {
    commands.push(
      `git config --local user.email ${quoteShellArg(args.githubAuth.accountEmail)}`,
    )
  }

  await args.sandbox.process.executeCommand(
    commands.join(' && '),
    args.workspacePath,
    undefined,
    30,
  )
}

export function getDocsPresetDefinition() {
  return getOpenCodeAgentPreset('docs-writer')
}
