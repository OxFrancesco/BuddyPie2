import type { OpenCodeModelOptionDefinition } from './types'

export const openCodeModelOptionMap = {
  'openrouter-minimax-m2.7': {
    id: 'openrouter-minimax-m2.7',
    label: 'OpenRouter / MiniMax M2.7',
    description:
      'Current default model path through OpenRouter for balanced general work.',
    provider: 'openrouter',
    providerLabel: 'OpenRouter',
    model: 'minimax/minimax-m2.7',
    modelLabel: 'MiniMax M2.7',
    requiredEnv: ['OPENROUTER_API_KEY'],
  },
  'venice-gpt-5.3-codex': {
    id: 'venice-gpt-5.3-codex',
    label: 'Venice / GPT-5.3 Codex',
    description:
      'Venice-built-in provider option tuned for coding and tool use.',
    provider: 'venice',
    providerLabel: 'Venice AI',
    model: 'openai-gpt-53-codex',
    modelLabel: 'GPT-5.3 Codex',
    requiredEnv: ['VENICE_API_KEY'],
  },
  'venice-claude-sonnet-4.6': {
    id: 'venice-claude-sonnet-4.6',
    label: 'Venice / Claude Sonnet 4.6',
    description:
      'Venice-built-in provider option with a larger context window for broad repo analysis and writing.',
    provider: 'venice',
    providerLabel: 'Venice AI',
    model: 'claude-sonnet-4-6',
    modelLabel: 'Claude Sonnet 4.6',
    requiredEnv: ['VENICE_API_KEY'],
  },
  'venice-minimax-m2.7': {
    id: 'venice-minimax-m2.7',
    label: 'Venice / MiniMax M2.7',
    description:
      'Venice-built-in provider option using MiniMax M2.7 for the docs workflow default.',
    provider: 'venice',
    providerLabel: 'Venice AI',
    model: 'minimax-m27',
    modelLabel: 'MiniMax M2.7',
    requiredEnv: ['VENICE_API_KEY'],
  },
} as const satisfies Record<string, OpenCodeModelOptionDefinition>

export type OpenCodeModelOptionId = keyof typeof openCodeModelOptionMap
export type OpenCodeModelOption = OpenCodeModelOptionDefinition & {
  id: OpenCodeModelOptionId
}

export const defaultOpenCodeModelOptionId: OpenCodeModelOptionId =
  'openrouter-minimax-m2.7'

export const openCodeModelOptions = Object.values(
  openCodeModelOptionMap,
) as Array<OpenCodeModelOption>

export function isOpenCodeModelOptionId(
  value: string,
): value is OpenCodeModelOptionId {
  return value in openCodeModelOptionMap
}

export function getOpenCodeModelOption(value: string): OpenCodeModelOption {
  if (!isOpenCodeModelOptionId(value)) {
    throw new Error('Choose a valid BuddyPie model before launching a sandbox.')
  }

  return openCodeModelOptionMap[value] as OpenCodeModelOption
}

export function getOpenCodeModelOptionByProviderAndModel(
  provider?: string | null,
  model?: string | null,
): OpenCodeModelOption | null {
  if (!provider || !model) {
    return null
  }

  return (
    openCodeModelOptions.find(
      (option) => option.provider === provider && option.model === model,
    ) ?? null
  )
}

export function resolveOpenCodeModelOption(input?: {
  provider?: string | null
  model?: string | null
  fallbackProvider?: string | null
  fallbackModel?: string | null
}): OpenCodeModelOption {
  const provider = input?.provider?.trim()
  const model = input?.model?.trim()

  if (provider || model) {
    if (!provider || !model) {
      throw new Error(
        'Choose both a model provider and model before launching a sandbox.',
      )
    }

    const matched = getOpenCodeModelOptionByProviderAndModel(provider, model)

    if (!matched) {
      throw new Error(
        `Choose a supported BuddyPie model. '${provider}/${model}' is not configured.`,
      )
    }

    return matched
  }

  const fallbackMatch = getOpenCodeModelOptionByProviderAndModel(
    input?.fallbackProvider,
    input?.fallbackModel,
  )

  if (fallbackMatch) {
    return fallbackMatch
  }

  return getOpenCodeModelOption(defaultOpenCodeModelOptionId)
}
