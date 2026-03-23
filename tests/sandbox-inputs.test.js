import { describe, expect, test } from 'bun:test'
import { normalizeSandboxInput } from '../src/lib/sandboxes.ts'

describe('normalizeSandboxInput', () => {
  test('requires a repository for repo-backed presets', () => {
    expect(() =>
      normalizeSandboxInput({
        agentPresetId: 'general-engineer',
      }),
    ).toThrow('A repository URL is required for this preset.')
  })

  test('allows the nansen preset to launch without a repository', () => {
    expect(
      normalizeSandboxInput({
        agentPresetId: 'nansen-analyst',
      }),
    ).toMatchObject({
      repoUrl: undefined,
      branch: undefined,
      repoName: 'Nansen Analyst',
      repoProvider: undefined,
      agentPresetId: 'nansen-analyst',
      agentLabel: 'Nansen Analyst',
    })
  })

  test('still normalizes repository metadata when an optional preset gets a repo', () => {
    expect(
      normalizeSandboxInput({
        agentPresetId: 'nansen-analyst',
        repoUrl: 'https://github.com/acme/onchain-research.git',
        branch: 'main',
      }),
    ).toMatchObject({
      repoUrl: 'https://github.com/acme/onchain-research.git',
      branch: 'main',
      repoName: 'onchain-research',
      repoProvider: 'github',
    })
  })
})
