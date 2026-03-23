import { describe, expect, test } from 'bun:test'
import {
  getOpenCodeAgentPreset,
  getOpenCodeModelOptionByProviderAndModel,
  openCodeAgentPresets,
  resolveOpenCodeModelOption,
} from '../src/lib/opencode/presets.ts'

describe('resolveOpenCodeModelOption', () => {
  test('returns the configured Venice MiniMax model when provider and model are supplied', () => {
    expect(
      resolveOpenCodeModelOption({
        provider: 'venice',
        model: 'minimax-m27',
      }),
    ).toMatchObject({
      provider: 'venice',
      model: 'minimax-m27',
      requiredEnv: ['VENICE_API_KEY'],
    })
  })

  test('falls back to the preset default pair when no override is supplied', () => {
    expect(
      resolveOpenCodeModelOption({
        fallbackProvider: 'openrouter',
        fallbackModel: 'minimax/minimax-m2.7',
      }),
    ).toMatchObject({
      provider: 'openrouter',
      model: 'minimax/minimax-m2.7',
      requiredEnv: ['OPENROUTER_API_KEY'],
    })
  })

  test('rejects unknown provider and model pairs', () => {
    expect(() =>
      resolveOpenCodeModelOption({
        provider: 'venice',
        model: 'not-a-real-model',
      }),
    ).toThrow(
      "Choose a supported BuddyPie model. 'venice/not-a-real-model' is not configured.",
    )
  })
})

describe('getOpenCodeModelOptionByProviderAndModel', () => {
  test('returns null for unknown pairs', () => {
    expect(
      getOpenCodeModelOptionByProviderAndModel('openrouter', 'unknown'),
    ).toBeNull()
  })
})

describe('preset model defaults', () => {
  test('uses Venice MiniMax M2.7 for the docs preset default', () => {
    expect(getOpenCodeAgentPreset('docs-writer')).toMatchObject({
      defaultModelOptionId: 'venice-minimax-m2.7',
      provider: 'venice',
      model: 'minimax-m27',
      requiredEnv: ['VENICE_API_KEY'],
    })
  })

  test('ships a built-in kickoff prompt for the general preset', () => {
    expect(getOpenCodeAgentPreset('general-engineer').starterPrompt.trim()).not.toBe(
      '',
    )
  })

  test('defines the nansen preset with artifact guidance and the extra API key requirement', () => {
    const preset = getOpenCodeAgentPreset('nansen-analyst')

    expect(preset).toMatchObject({
      repositoryOptional: true,
      defaultModelOptionId: 'venice-minimax-m2.7',
      provider: 'venice',
      model: 'minimax-m27',
    })
    expect(preset.requiredEnv).toEqual(
      expect.arrayContaining(['VENICE_API_KEY', 'NANSEN_API_KEY']),
    )
    expect(preset.instructionsMd).toContain('.buddypie/artifacts/current.json')
    expect(preset.instructionsMd).toContain('write it atomically')
    expect(preset.instructionsMd).toContain('validate the temp file before promotion')
    expect(preset.instructionsMd).toContain('do not use leading `+` on numbers')
    expect(preset.instructionsMd).toContain('unsupported section or field types')
    expect(preset.instructionsMd).toContain('.buddypie/artifacts/history/')
    expect(preset.starterPrompt).toContain('.buddypie/artifacts/current.json')
    expect(preset.starterPrompt).toContain('Validate the temp JSON with a real parser')
    expect(preset.starterPrompt).toContain('Archive each full validated dashboard')
  })

  test('adds the shared delivery workflow to every preset prompt and instructions', () => {
    for (const preset of openCodeAgentPresets) {
      expect(preset.agentPrompt).toContain(
        'Do not wait for a follow-up prompt before finishing delivery',
      )
      expect(preset.agentPrompt).toContain('run the relevant build command')
      expect(preset.agentPrompt).toContain('run the relevant typecheck command')
      expect(preset.agentPrompt).toContain('dedicated working branch')
      expect(preset.agentPrompt).toContain('push the current branch')
      expect(preset.instructionsMd).toContain('## Required Delivery Workflow')
      expect(preset.instructionsMd).toContain(
        'Do not wait for a follow-up prompt before finishing delivery for the initial request.',
      )
      expect(preset.instructionsMd).toContain('Use Bun for Node and TypeScript repo commands')
      expect(preset.instructionsMd).toContain('dedicated working branch')
      expect(preset.instructionsMd).toContain('push the current branch')
    }
  })

  test('adds explicit bun docs verification steps to the docs preset', () => {
    const preset = getOpenCodeAgentPreset('docs-writer')

    expect(preset.instructionsMd).toContain('use `bun` for install, dev, typecheck, preview, and build commands')
    expect(preset.instructionsMd).toContain('`bun run types:check`')
    expect(preset.instructionsMd).toContain('`bun run build`')
    expect(preset.instructionsMd).toContain('`bun run dev` or `bun run preview`')
    expect(preset.instructionsMd).toContain('When `sources/fumadocs` is absent')
    expect(preset.starterPrompt).toContain('Validate the result with Bun inside the docs app')
    expect(preset.workspaceBootstrap?.packageManager).toBe('bun')
  })
})
