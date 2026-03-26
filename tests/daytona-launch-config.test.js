import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildOpenCodeConfig,
  buildInitialPromptContent,
  buildOpenCodeSessionPreviewUrl,
  isolateSandboxGitBranch,
  resolveOpenCodeLaunchConfig,
} from '../src/lib/server/daytona.ts'
import { getOpenCodeAgentPreset } from '../src/lib/opencode/presets.ts'
import { buildSandboxWorkBranchName } from '../src/lib/sandboxes.ts'

const ORIGINAL_ENV = { ...process.env }

describe('resolveOpenCodeLaunchConfig', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  test('throws before sandbox creation when a required provider key is missing', () => {
    delete process.env.VENICE_API_KEY

    expect(() =>
      resolveOpenCodeLaunchConfig({
        agentPresetId: 'docs-writer',
        agentProvider: 'venice',
        agentModel: 'minimax-m27',
      }),
    ).toThrow(
      'VENICE_API_KEY or VENICE_INFERENCE_KEY is not configured on the server.',
    )
  })

  test('uses the configured Venice API key for the docs preset default', () => {
    process.env.VENICE_API_KEY = 'test-venice-key'

    expect(
      resolveOpenCodeLaunchConfig({
        agentPresetId: 'docs-writer',
        agentProvider: 'venice',
        agentModel: 'minimax-m27',
      }),
    ).toMatchObject({
      preset: {
        id: 'docs-writer',
        provider: 'venice',
        model: 'minimax-m27',
      },
      launchEnvironment: {
        VENICE_API_KEY: 'test-venice-key',
      },
    })
  })

  test('accepts VENICE_INFERENCE_KEY as an alias for VENICE_API_KEY', () => {
    delete process.env.VENICE_API_KEY
    process.env.VENICE_INFERENCE_KEY = 'test-venice-inference-key'

    expect(
      resolveOpenCodeLaunchConfig({
        agentPresetId: 'docs-writer',
        agentProvider: 'venice',
        agentModel: 'minimax-m27',
      }),
    ).toMatchObject({
      launchEnvironment: {
        VENICE_API_KEY: 'test-venice-inference-key',
      },
    })
  })

  test('injects the GitHub token aliases and account login needed for PR flows', () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

    const { launchEnvironment } = resolveOpenCodeLaunchConfig({
      agentPresetId: 'general-engineer',
      agentProvider: 'openrouter',
      agentModel: 'minimax/minimax-m2.7',
      githubAuth: {
        token: 'ghu_test_token',
        scopes: ['repo', 'read:user'],
        accountLogin: 'octocat',
        accountName: 'The Octocat',
        accountEmail: 'octocat@example.com',
      },
    })

    expect(launchEnvironment).toMatchObject({
      OPENROUTER_API_KEY: 'test-openrouter-key',
      GITHUB_TOKEN: 'ghu_test_token',
      GH_TOKEN: 'ghu_test_token',
      GITHUB_OAUTH_SCOPES: 'repo,read:user',
      GITHUB_OAUTH_ACCOUNT_LOGIN: 'octocat',
      GITHUB_ACTOR: 'octocat',
    })
    expect(launchEnvironment.GITHUB_OAUTH_ACCOUNT_EMAIL).toBeUndefined()
    expect(launchEnvironment.GITHUB_OAUTH_ACCOUNT_NAME).toBeUndefined()
    expect(launchEnvironment.GITHUB_OAUTH_ACCOUNT_ID).toBeUndefined()
  })

  test('throws before sandbox creation when the nansen preset key is missing', () => {
    process.env.VENICE_API_KEY = 'test-venice-key'
    delete process.env.NANSEN_API_KEY

    expect(() =>
      resolveOpenCodeLaunchConfig({
        agentPresetId: 'nansen-analyst',
        agentProvider: 'venice',
        agentModel: 'minimax-m27',
      }),
    ).toThrow('NANSEN_API_KEY is not configured on the server.')
  })

  test('injects both the model key and the nansen key for the nansen preset', () => {
    process.env.VENICE_API_KEY = 'test-venice-key'
    process.env.NANSEN_API_KEY = 'test-nansen-key'

    expect(
      resolveOpenCodeLaunchConfig({
        agentPresetId: 'nansen-analyst',
        agentProvider: 'venice',
        agentModel: 'minimax-m27',
      }),
    ).toMatchObject({
      preset: {
        id: 'nansen-analyst',
        provider: 'venice',
        model: 'minimax-m27',
      },
      launchEnvironment: {
        VENICE_API_KEY: 'test-venice-key',
        VENICE_INFERENCE_KEY: 'test-venice-key',
        NANSEN_API_KEY: 'test-nansen-key',
      },
    })
  })
})

describe('buildOpenCodeSessionPreviewUrl', () => {
  test('opens the seeded session directly in the OpenCode web app', () => {
    expect(
      buildOpenCodeSessionPreviewUrl(
        'https://3000-sandbox.proxy.daytona.works/',
        '/home/daytona/example-repo',
        'session_123',
      ),
    ).toBe(
      'https://3000-sandbox.proxy.daytona.works/L2hvbWUvZGF5dG9uYS9leGFtcGxlLXJlcG8/session/session_123',
    )
  })

  test('keeps the root preview URL when no session is available', () => {
    expect(
      buildOpenCodeSessionPreviewUrl(
        'https://3000-sandbox.proxy.daytona.works/',
        '/home/daytona/example-repo',
      ),
    ).toBe('https://3000-sandbox.proxy.daytona.works/')
  })
})

describe('buildOpenCodeConfig', () => {
  test('grants the OpenCode web agent full access at both the session and agent levels', () => {
    const preset = getOpenCodeAgentPreset('general-engineer')
    const config = JSON.parse(
      buildOpenCodeConfig(
        preset,
        'https://{PORT}-sandbox.proxy.daytona.works/',
      ),
    )

    expect(config.permission).toBe('allow')
    expect(config.agent['general-engineer'].permission).toBe('allow')
  })
})

describe('buildInitialPromptContent', () => {
  test('appends the automatic build, typecheck, and push completion sequence', () => {
    const prompt = buildInitialPromptContent('Implement the requested change.')

    expect(prompt).toContain('## Required Completion Sequence')
    expect(prompt).toContain('run the relevant build command')
    expect(prompt).toContain('run the relevant typecheck command')
    expect(prompt).toContain('commit and push the current working branch to GitHub')
    expect(prompt).toContain(
      'Do not wait for a follow-up prompt before running this completion sequence.',
    )
  })
})

describe('isolateSandboxGitBranch', () => {
  test('creates, checks out, and retains a dedicated working branch instead of the cloned base branch', async () => {
    const operations = []
    let currentBranch = 'main'
    const git = {
      async clone() {
        throw new Error('clone should not be called during branch isolation')
      },
      async status() {
        return {
          currentBranch,
          ahead: 0,
          behind: 0,
          branchPublished: false,
          fileStatus: [],
        }
      },
      async createBranch(path, name) {
        operations.push(['createBranch', path, name])
      },
      async checkoutBranch(path, branch) {
        operations.push(['checkoutBranch', path, branch])
        currentBranch = branch
      },
      async deleteBranch(path, name) {
        operations.push(['deleteBranch', path, name])
      },
    }

    const originalNow = Date.now
    Date.now = () => 9337286

    try {
      const workBranch = buildSandboxWorkBranchName({
        repoName: 'buddy-pie',
        baseBranch: 'main',
      })
      const result = await isolateSandboxGitBranch({
        git,
        workspacePath: '/home/daytona/buddy-pie',
        repoName: 'buddy-pie',
      })

      expect(result).toEqual({
        baseBranch: 'main',
        workBranch,
      })
      expect(operations).toEqual([
        ['createBranch', '/home/daytona/buddy-pie', workBranch],
        ['checkoutBranch', '/home/daytona/buddy-pie', workBranch],
        ['deleteBranch', '/home/daytona/buddy-pie', 'main'],
      ])
    } finally {
      Date.now = originalNow
    }
  })
})
