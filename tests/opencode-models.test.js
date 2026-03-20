import { describe, expect, test } from 'bun:test'
import {
  getOpenCodeAgentPreset,
  getOpenCodeModelOptionByProviderAndModel,
  resolveOpenCodeModelOption,
} from '../src/lib/opencode/presets.ts'

describe('resolveOpenCodeModelOption', () => {
  test('returns the configured Venice model when provider and model are supplied', () => {
    expect(
      resolveOpenCodeModelOption({
        provider: 'venice',
        model: 'openai-gpt-53-codex',
      }),
    ).toMatchObject({
      provider: 'venice',
      model: 'openai-gpt-53-codex',
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
  test('uses Venice GLM 5 for the docs preset default', () => {
    expect(getOpenCodeAgentPreset('docs-writer')).toMatchObject({
      defaultModelOptionId: 'venice-glm-5',
      provider: 'venice',
      model: 'zai-org-glm-5',
      requiredEnv: ['VENICE_API_KEY'],
    })
  })

  test('ships a built-in kickoff prompt for the general preset', () => {
    expect(getOpenCodeAgentPreset('general-engineer').starterPrompt.trim()).not.toBe(
      '',
    )
  })
})
