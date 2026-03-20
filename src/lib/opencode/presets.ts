export type OpenCodeSkillPermission = 'allow' | 'ask' | 'deny'

export type OpenCodeManagedSkill = {
  id: string
  name: string
  description: string
  content: string
  permission?: OpenCodeSkillPermission
}

export type OpenCodeManagedMcp = {
  command: string
  args?: Array<string>
  env?: Array<string>
}

export type OpenCodeDocsWorkspaceBootstrap = {
  kind: 'fumadocs-docs-app'
  sourceRepoUrl: string
  sourceRepoBranch: string
  sourceRepoPath: string
  docsTemplate: 'tanstack-start'
  preferredDocsPath: string
  fallbackDocsPath: string
  packageManager: 'bun'
}

export type OpenCodeWorkspaceBootstrap = OpenCodeDocsWorkspaceBootstrap

type OpenCodeModelOptionDefinition = {
  id: string
  label: string
  description: string
  provider: string
  providerLabel: string
  model: string
  modelLabel: string
  requiredEnv: Array<string>
}

type OpenCodeAgentPresetDefinition = {
  id: string
  label: string
  description: string
  defaultModelOptionId: string
  provider: string
  model: string
  requiredEnv: Array<string>
  agentPrompt: string
  instructionsMd: string
  starterPrompt: string
  starterPromptPlaceholder: string
  skills: Array<OpenCodeManagedSkill>
  mcp: Record<string, OpenCodeManagedMcp>
  workspaceBootstrap?: OpenCodeWorkspaceBootstrap
}

const openCodeModelOptionMap = {
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
  'venice-glm-5': {
    id: 'venice-glm-5',
    label: 'Venice / GLM 5',
    description:
      'Venice-built-in provider option using GLM 5 for the docs workflow default.',
    provider: 'venice',
    providerLabel: 'Venice AI',
    model: 'zai-org-glm-5',
    modelLabel: 'GLM 5',
    requiredEnv: ['VENICE_API_KEY'],
  },
} as const satisfies Record<string, OpenCodeModelOptionDefinition>

const openCodePresetMap = {
  'general-engineer': {
    id: 'general-engineer',
    label: 'General Engineer',
    description:
      'Balanced repo analysis and implementation for full-stack product work.',
    defaultModelOptionId: 'openrouter-minimax-m2.7',
    provider: 'openrouter',
    model: 'minimax/minimax-m2.7',
    requiredEnv: ['OPENROUTER_API_KEY'],
    agentPrompt:
      'Act as a pragmatic software engineer who starts with the smallest high-confidence plan, keeps changes scoped, and verifies important behavior before handing work back.',
    instructionsMd: `
# BuddyPie General Engineer

This sandbox was launched from BuddyPie with the general-purpose engineering preset.

## Priorities

- Understand the existing architecture before changing it.
- Prefer small, reversible edits over broad rewrites.
- Keep implementation, tests, and documentation aligned.
- Call out risks, migrations, and follow-up work when something cannot be fully verified.

## Workflow

- Inspect the repo first and summarize the relevant architecture.
- Reuse existing patterns, utilities, and components before introducing new abstractions.
- Validate the changed behavior with the narrowest useful command or check.
- Load the BuddyPie skills listed below when they match the task.

## BuddyPie Skills

- \`buddypie-general-architecture\` for repo walkthroughs, system mapping, and change planning.
- \`buddypie-general-release-check\` before final verification and handoff.
`.trim(),
    starterPrompt:
      'Inspect this repository, identify the files and systems relevant to the requested task, and start with the smallest high-confidence plan before editing. Then implement the change, verify the behavior you touched, and summarize the result with any remaining risks or follow-up work.',
    starterPromptPlaceholder:
      'Describe the feature, bug, or refactor you want this workspace to tackle.',
    skills: [
      {
        id: 'buddypie-general-architecture',
        name: 'buddypie-general-architecture',
        description:
          'Map the architecture before making cross-cutting product changes.',
        content: `
---
name: buddypie-general-architecture
description: Map the architecture before making cross-cutting product changes.
compatibility: opencode
---

## What I do

- Identify the smallest set of files that control the requested behavior.
- Summarize data flow, ownership, and side effects before implementation.
- Highlight constraints that could affect rollout or testing.

## When to use me

Use this before refactors, new features that touch multiple layers, or any task where the architecture is not obvious yet.
`.trim(),
      },
      {
        id: 'buddypie-general-release-check',
        name: 'buddypie-general-release-check',
        description:
          'Wrap up implementation with focused verification and handoff notes.',
        content: `
---
name: buddypie-general-release-check
description: Wrap up implementation with focused verification and handoff notes.
compatibility: opencode
---

## What I do

- Review changed files for behavior regressions and missing validation.
- Check whether tests, docs, or environment requirements changed.
- Produce a concise handoff with remaining risks.

## When to use me

Use this near the end of implementation before reporting completion back to the user.
`.trim(),
      },
    ],
    mcp: {},
  },
  'frontend-builder': {
    id: 'frontend-builder',
    label: 'Frontend Builder',
    description:
      'UI-focused preset for React, styling, accessibility, and polish work.',
    defaultModelOptionId: 'openrouter-minimax-m2.7',
    provider: 'openrouter',
    model: 'minimax/minimax-m2.7',
    requiredEnv: ['OPENROUTER_API_KEY'],
    agentPrompt:
      'Act as a frontend specialist. Optimize for UI clarity, responsive behavior, accessibility, and design-system consistency while keeping implementation grounded in the existing product.',
    instructionsMd: `
# BuddyPie Frontend Builder

This sandbox was launched with BuddyPie's frontend preset.

## Priorities

- Preserve product behavior while improving the interface.
- Prefer existing design-system components, semantic tokens, and shared layout patterns.
- Treat empty, loading, error, and success states as first-class UI work.
- Check accessibility basics such as focus order, keyboard usage, semantics, and readable copy.

## Workflow

- Inspect the relevant routes and components before editing.
- Describe the intended UI change and the smallest implementation path.
- Keep styling changes cohesive instead of scattering one-off overrides.
- Load the BuddyPie skills below when they match the task.

## BuddyPie Skills

- \`buddypie-frontend-component-craft\` for component architecture, state, and composability.
- \`buddypie-frontend-ui-polish\` for layout polish, responsive behavior, and accessibility review.
`.trim(),
    starterPrompt:
      'Audit the relevant UI surfaces in this repository, identify the files that control the experience, and propose the smallest high-confidence frontend plan before editing.',
    starterPromptPlaceholder:
      'Describe the UI task, component, route, or visual issue to solve.',
    skills: [
      {
        id: 'buddypie-frontend-component-craft',
        name: 'buddypie-frontend-component-craft',
        description:
          'Plan and implement UI changes using reusable component patterns.',
        content: `
---
name: buddypie-frontend-component-craft
description: Plan and implement UI changes using reusable component patterns.
compatibility: opencode
---

## What I do

- Break a UI task into the smallest useful component or route changes.
- Prefer composition over bespoke one-off structures.
- Keep state, data flow, and view logic understandable.

## When to use me

Use this before editing route components, shared UI, or form flows.
`.trim(),
      },
      {
        id: 'buddypie-frontend-ui-polish',
        name: 'buddypie-frontend-ui-polish',
        description:
          'Review UI work for responsiveness, accessibility, and finishing details.',
        content: `
---
name: buddypie-frontend-ui-polish
description: Review UI work for responsiveness, accessibility, and finishing details.
compatibility: opencode
---

## What I do

- Check spacing, hierarchy, and readable copy.
- Review hover, focus, disabled, loading, and error states.
- Flag accessibility and responsive layout regressions before handoff.

## When to use me

Use this after implementing UI changes and before reporting the result.
`.trim(),
      },
    ],
    mcp: {},
  },
  'docs-writer': {
    id: 'docs-writer',
    label: 'Docs Writer',
    description:
      'Documentation-focused preset for guides, READMEs, onboarding, and changelogs.',
    defaultModelOptionId: 'venice-glm-5',
    provider: 'venice',
    model: 'zai-org-glm-5',
    requiredEnv: ['VENICE_API_KEY'],
    agentPrompt:
      'Act as a documentation specialist. Prioritize accuracy, crisp structure, runnable examples, and explanations that match the current code instead of idealized behavior. When BuddyPie prepares a Fumadocs docs app, use the product repo for project truth and the Fumadocs reference repo for framework truth.',
    instructionsMd: `
# BuddyPie Docs Writer

This sandbox was launched with BuddyPie's documentation preset.

## Priorities

- Document what the code actually does today.
- Build a complete project docs site, not just a single README, when the task calls for broader documentation coverage.
- Prefer short sections, clear headings, and copy-pasteable commands.
- Explain setup, validation, and edge cases without marketing language.
- Update adjacent examples when behavior or environment requirements change.

## Workspace Setup

- BuddyPie clones the product repository into the workspace root.
- BuddyPie also clones \`https://github.com/fuma-nama/fumadocs.git\` into \`sources/fumadocs\` on branch \`main\`.
- BuddyPie scaffolds a Fumadocs React app in \`docs/\` or \`docs-site/\` when \`docs/\` is already occupied.

## Workflow

- Audit the source files first so the docs stay anchored in reality.
- Treat the product repository as the source of truth for product behavior, APIs, environment requirements, and project-specific facts.
- Treat \`sources/fumadocs\` as the source of truth for Fumadocs structure, conventions, and examples.
- Identify the audience for the requested document before writing.
- Prefer Bun commands for install, dev, and build work inside the generated docs app.
- Keep prose direct, concrete, and easy to scan.
- Load the BuddyPie skills below when they match the task.

## BuddyPie Skills

- \`buddypie-docs-structure\` for README, guide, and architecture-document planning.
- \`buddypie-docs-qa\` for factual verification and editorial cleanup before handoff.
`.trim(),
    starterPrompt:
      'Review the current repository, identify the documentation gaps that matter most, and build a complete Fumadocs docs pass for this project. Cover the docs landing page, getting started and local setup, architecture and major subsystems, environment and configuration, development workflow, deployment or operations, and any API or integration docs that the codebase supports. Outline the structure before editing, then write or update the docs app content using the prepared Fumadocs workspace.',
    starterPromptPlaceholder:
      'Describe the docs site, guide, README, release note, or documentation change you need.',
    workspaceBootstrap: {
      kind: 'fumadocs-docs-app',
      sourceRepoUrl: 'https://github.com/fuma-nama/fumadocs.git',
      sourceRepoBranch: 'main',
      sourceRepoPath: 'sources/fumadocs',
      docsTemplate: 'tanstack-start',
      preferredDocsPath: 'docs',
      fallbackDocsPath: 'docs-site',
      packageManager: 'bun',
    },
    skills: [
      {
        id: 'buddypie-docs-structure',
        name: 'buddypie-docs-structure',
        description:
          'Plan documentation structure around audience, outcomes, and runnable steps.',
        content: `
---
name: buddypie-docs-structure
description: Plan documentation structure around audience, outcomes, and runnable steps.
compatibility: opencode
---

## What I do

- Identify the audience and the main jobs the document needs to support.
- Organize content into a clean, skimmable structure.
- Make sure examples, commands, and caveats appear in the right order.

## When to use me

Use this before writing a new README, guide, migration note, or architecture summary.
`.trim(),
      },
      {
        id: 'buddypie-docs-qa',
        name: 'buddypie-docs-qa',
        description:
          'Verify docs against the code and tighten the final writing.',
        content: `
---
name: buddypie-docs-qa
description: Verify docs against the code and tighten the final writing.
compatibility: opencode
---

## What I do

- Cross-check the docs against the code and current configuration.
- Remove vague claims, stale steps, and redundant wording.
- Highlight anything that still needs user or runtime validation.

## When to use me

Use this after drafting docs and before the final handoff.
`.trim(),
      },
    ],
    mcp: {},
  },
} as const satisfies Record<string, OpenCodeAgentPresetDefinition>

export type OpenCodeModelOptionId = keyof typeof openCodeModelOptionMap
export type OpenCodeModelOption = OpenCodeModelOptionDefinition & {
  id: OpenCodeModelOptionId
}
export type OpenCodeAgentPresetId = keyof typeof openCodePresetMap
export type OpenCodeAgentPreset = OpenCodeAgentPresetDefinition & {
  id: OpenCodeAgentPresetId
}
export const defaultOpenCodeModelOptionId: OpenCodeModelOptionId =
  'openrouter-minimax-m2.7'
export const defaultOpenCodeAgentPresetId: OpenCodeAgentPresetId =
  'general-engineer'

export const openCodeModelOptions = Object.values(
  openCodeModelOptionMap,
) as Array<OpenCodeModelOption>
export const openCodeAgentPresets = Object.values(
  openCodePresetMap,
) as Array<OpenCodeAgentPreset>

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

export function isOpenCodeAgentPresetId(
  value: string,
): value is OpenCodeAgentPresetId {
  return value in openCodePresetMap
}

export function getOpenCodeAgentPreset(value: string): OpenCodeAgentPreset {
  if (!isOpenCodeAgentPresetId(value)) {
    throw new Error(
      'Choose a valid BuddyPie preset before launching a sandbox.',
    )
  }

  return openCodePresetMap[value] as OpenCodeAgentPreset
}

export function getSafeOpenCodeAgentPreset(
  value?: string | null,
): OpenCodeAgentPreset {
  if (value && isOpenCodeAgentPresetId(value)) {
    return openCodePresetMap[value] as OpenCodeAgentPreset
  }

  return openCodePresetMap[defaultOpenCodeAgentPresetId] as OpenCodeAgentPreset
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

export function withOpenCodeModelOption(
  preset: OpenCodeAgentPreset,
  option: OpenCodeModelOption,
): OpenCodeAgentPreset {
  return {
    ...preset,
    provider: option.provider,
    model: option.model,
    requiredEnv: [...option.requiredEnv],
  }
}
