export type {
  OpenCodeAgentPresetDefinition,
  OpenCodeDocsWorkspaceBootstrap,
  OpenCodeManagedMcp,
  OpenCodeManagedSkill,
  OpenCodeModelOptionDefinition,
  OpenCodeSkillPermission,
  OpenCodeWorkspaceBootstrap,
} from './presets/types'

export {
  defaultOpenCodeAgentPresetId,
  getOpenCodeAgentPreset,
  getSafeOpenCodeAgentPreset,
  isOpenCodeAgentPresetId,
  openCodeAgentPresets,
  openCodePresetMap,
} from './presets/definitions'
export type {
  OpenCodeAgentPreset,
  OpenCodeAgentPresetId,
} from './presets/definitions'

export {
  defaultOpenCodeModelOptionId,
  getOpenCodeModelOption,
  getOpenCodeModelOptionByProviderAndModel,
  isOpenCodeModelOptionId,
  openCodeModelOptionMap,
  openCodeModelOptions,
  resolveOpenCodeModelOption,
} from './presets/models'
export type {
  OpenCodeModelOption,
  OpenCodeModelOptionId,
} from './presets/models'

export function withOpenCodeModelOption(
  preset: import('./presets/definitions').OpenCodeAgentPreset,
  option: import('./presets/models').OpenCodeModelOption,
): import('./presets/definitions').OpenCodeAgentPreset {
  return {
    ...preset,
    provider: option.provider,
    model: option.model,
    requiredEnv: Array.from(
      new Set([...preset.requiredEnv, ...option.requiredEnv]),
    ),
  }
}
