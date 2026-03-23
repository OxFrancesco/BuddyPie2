import {
  withSharedDeliveryInstructions,
  withSharedDeliveryPrompt,
} from './shared'
import type { OpenCodeAgentPresetDefinition } from './types'

export const openCodePresetMap = {
  'general-engineer': {
    id: 'general-engineer',
    label: 'General Engineer',
    description:
      'Balanced repo analysis and implementation for full-stack product work.',
    defaultModelOptionId: 'openrouter-minimax-m2.7',
    provider: 'openrouter',
    model: 'minimax/minimax-m2.7',
    requiredEnv: ['OPENROUTER_API_KEY'],
    agentPrompt: withSharedDeliveryPrompt(
      'Act as a pragmatic software engineer who starts with the smallest high-confidence plan, keeps changes scoped, and verifies important behavior before handing work back.',
    ),
    instructionsMd: withSharedDeliveryInstructions(
      `
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
    ),
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
    agentPrompt: withSharedDeliveryPrompt(
      'Act as a frontend specialist. Optimize for UI clarity, responsive behavior, accessibility, and design-system consistency while keeping implementation grounded in the existing product.',
    ),
    instructionsMd: withSharedDeliveryInstructions(
      `
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
    ),
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
  'nansen-analyst': {
    id: 'nansen-analyst',
    label: 'Nansen Analyst',
    description:
      'Onchain research preset for Nansen CLI workflows with ephemeral artifact UIs.',
    repositoryOptional: true,
    defaultModelOptionId: 'venice-minimax-m2.7',
    provider: 'venice',
    model: 'minimax-m27',
    requiredEnv: ['VENICE_API_KEY', 'NANSEN_API_KEY'],
    agentPrompt: withSharedDeliveryPrompt(
      'Act as an onchain research analyst. Use Nansen CLI as the primary source for Nansen-backed analytics, keep commands reproducible, and when a visual summary would help the user, publish a temporary artifact manifest for BuddyPie to render while keeping OpenCode as the main workspace.',
    ),
    instructionsMd: withSharedDeliveryInstructions(
      `
# BuddyPie Nansen Analyst

This sandbox was launched with BuddyPie's Nansen-focused research preset.

## Priorities

- Use \`nansen\` CLI for Nansen-backed research before reaching for ad hoc scripts.
- Prefer targeted queries with \`--fields\`, \`--limit\`, and the narrowest useful subcommand.
- Keep outputs reproducible so the user can rerun the same command from the sandbox.
- Use temporary artifact UIs for high-signal summaries, then delete them when they are no longer useful.

## Workflow

- Inspect the user's request and any attached repo before running Nansen commands.
- Use \`nansen schema --pretty\` when you need the CLI surface or output shape.
- Treat the Nansen CLI response as the source material, then summarize or visualize only the fields that matter.
- Keep artifacts read-only in v1. Do not rely on json-render actions or interactive workflows.
- When you publish an artifact, write it atomically:
  1. write JSON to \`.buddypie/artifacts/current.json.tmp\`
  2. validate the temp file before promotion with a real JSON parser, for example \`node -e "JSON.parse(require('node:fs').readFileSync('.buddypie/artifacts/current.json.tmp', 'utf8'))"\`
  3. if validation fails, fix the JSON and do not replace the live manifest
  4. create \`.buddypie/artifacts/history/\` if it does not exist
  5. if \`.buddypie/artifacts/current.json\` already exists, copy that full previous dashboard into \`.buddypie/artifacts/history/\` before replacing it
  6. copy the new validated temp file into \`.buddypie/artifacts/history/\` with a timestamped filename so each complete dashboard is saved
  7. rename it to \`.buddypie/artifacts/current.json\`
- Artifact manifest contract:
  - path: \`.buddypie/artifacts/current.json\`
  - missing file means there is no active artifact
  - replacing the file replaces the current artifact
  - deleting the file clears the artifact panel
  - archive path: \`.buddypie/artifacts/history/\`
  - JSON shape:
    - \`version\`: \`1\`
    - \`kind\`: \`json-render\`
    - \`title\`: short title
    - \`summary\`: optional concise summary
    - \`generatedAt\`: ISO timestamp
    - \`spec\`: json-render spec object
- JSON must be strict JSON:
  - do not use leading \`+\` on numbers
  - do not use trailing commas
  - do not use comments
  - all keys and string values must be double-quoted
- Preferred simplified artifact layout for BuddyPie Nansen artifacts:
  - \`spec.layout\`: \`cards\`
  - \`spec.sections\`: array of sections
  - supported section types:
    - \`card\` with \`title\`, optional \`fields\`, optional \`table\`
    - \`alert\` with \`title\`, optional \`body\`, optional \`alert\`
    - \`separator\`
    - \`relation-graph\` with \`title\`, optional \`description\`, optional \`center\`, \`nodes\`, and \`edges\`
- Do not invent unsupported section or field types such as ad hoc \`chart\` payloads unless the BuddyPie manifest contract explicitly supports them.
- Prefer read-only analytics layouts such as cards, headings, text, badges, tables, grids, separators, progress, alerts, and relation graphs.
- Keep artifact copy concise and use the chat thread for detailed caveats.
- Delete \`.buddypie/artifacts/current.json\` once the artifact is stale, superseded, or no longer useful.
- Keep archived snapshots in \`.buddypie/artifacts/history/\` unless the user explicitly asks you to prune them.
- If \`nansen\` is not on PATH in a shell, run \`export PATH="$HOME/.bun/bin:$PATH"\` and retry.
- Load the BuddyPie skills below when they match the task.

## BuddyPie Skills

- \`nansen-general-search\` when the user has a token or entity name and needs a precise identifier.
- \`nansen-wallet-profiler\` when analyzing one or more wallets.
- \`nansen-token-research\` when doing a token deep dive.
- \`nansen-smart-money-trend\` when the request is about smart-money flows or activity trends.
`.trim(),
    ),
    starterPrompt:
      'Review the request, identify the smallest set of Nansen CLI commands that can answer it, and inspect any attached repo before editing. Use Nansen CLI for the research work, summarize the result clearly, and when a visual snapshot would help, publish a temporary artifact manifest at `.buddypie/artifacts/current.json` for BuddyPie to render. Prefer the simplified BuddyPie cards layout with card, alert, separator, and relation-graph sections. Validate the temp JSON with a real parser before promoting it, and do not publish malformed JSON or unsupported section types. Archive each full validated dashboard under `.buddypie/artifacts/history/` before replacing `current.json`, keep the artifact read-only, replace it atomically when it changes, and delete it when it is no longer useful.',
    starterPromptPlaceholder:
      'Describe the wallet, token, smart-money flow, or onchain research question to investigate.',
    skills: [
      {
        id: 'nansen-general-search',
        name: 'nansen-general-search',
        description:
          'Search for tokens or entities by name before drilling into a specific identifier.',
        content: `
---
name: nansen-general-search
description: Search for tokens or entities by name. Use when you have a token name and need the full address, or want to find an entity.
compatibility: opencode
---

# Search

\`\`\`bash
nansen research search "jupiter" --type token
nansen research search "Vitalik" --type entity --limit 5
nansen research search "bonk" --chain solana --fields address,name,symbol,chain
\`\`\`

## Notes

- Use \`--type token\` or \`--type entity\` when ambiguity matters.
- Use \`--fields\` to keep output small.
- Search is case-insensitive.
- Search does not match raw addresses. Use profiler labels for address lookup.
`.trim(),
      },
      {
        id: 'nansen-wallet-profiler',
        name: 'nansen-wallet-profiler',
        description:
          'Profile wallets for balances, labels, PnL, counterparties, and related activity.',
        content: `
---
name: nansen-wallet-profiler
description: Wallet profiler — balance, PnL, labels, transactions, counterparties, related wallets, batch, trace, compare. Use when analysing a specific wallet address or comparing wallets.
compatibility: opencode
---

# Wallet Profiler

All commands: \`nansen research profiler <subcommand> [options]\`

\`\`\`bash
nansen research profiler balance --address <addr> --chain ethereum
nansen research profiler labels --address <addr> --chain ethereum
nansen research profiler pnl-summary --address <addr> --chain ethereum
nansen research profiler transactions --address <addr> --chain ethereum --limit 20
nansen research profiler related-wallets --address <addr> --chain ethereum
\`\`\`

## Notes

- Most subcommands require \`--address\` and \`--chain\`.
- Use \`--fields\` and \`--limit\` to keep the response focused.
- \`trace\` and \`batch\` can fan out into many calls. Keep them narrow.
`.trim(),
      },
      {
        id: 'nansen-token-research',
        name: 'nansen-token-research',
        description:
          'Research a token across info, holders, flows, trades, and PnL surfaces.',
        content: `
---
name: nansen-token-research
description: Token deep dive — info, OHLCV, holders, flows, flow intelligence, who bought/sold, DEX trades, PnL, perp trades, perp positions, perp PnL leaderboard. Use when researching a specific token in depth.
compatibility: opencode
---

# Token Deep Dive

All commands: \`nansen research token <subcommand> [options]\`

\`\`\`bash
nansen research token info --token <addr> --chain solana
nansen research token holders --token <addr> --chain solana
nansen research token flows --token <addr> --chain solana --days 7
nansen research token dex-trades --token <addr> --chain solana --limit 20
nansen research token pnl --token <addr> --chain solana --sort total_pnl_usd:desc
\`\`\`

## Notes

- Spot token endpoints require \`--chain\`.
- Perp endpoints use \`--symbol\`, not \`--token\`.
- \`holders --smart-money\` can fail on tokens without smart-money tracking.
`.trim(),
      },
      {
        id: 'nansen-smart-money-trend',
        name: 'nansen-smart-money-trend',
        description:
          'Track smart-money flows and activity trends for tokens or ecosystems.',
        content: `
---
name: nansen-smart-money-trend
description: Smart money trends across flows, holdings, and DEX activity. Use when the user asks where sophisticated wallets are moving.
compatibility: opencode
---

# Smart Money Trends

All commands: \`nansen research smart-money <subcommand> [options]\`

\`\`\`bash
nansen research smart-money netflow --chain solana --limit 10
nansen research smart-money dex-trades --chain solana --limit 20
nansen research smart-money holdings --chain solana --limit 20
nansen research smart-money historical-holdings --chain solana --days 30
\`\`\`

## Notes

- Use \`--fields\` aggressively to reduce noise.
- \`netflow\` is the best starting point when the user asks where money is moving.
- Historical endpoints are better for trend artifacts than one-off snapshots.
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
    defaultModelOptionId: 'venice-minimax-m2.7',
    provider: 'venice',
    model: 'minimax-m27',
    requiredEnv: ['VENICE_API_KEY'],
    agentPrompt: withSharedDeliveryPrompt(
      'Act as a documentation specialist. Prioritize accuracy, crisp structure, runnable examples, and explanations that match the current code instead of idealized behavior. When BuddyPie prepares a Fumadocs docs app, use the product repo for project truth and the Fumadocs reference repo for framework truth when it is present. Inside the docs app, use Bun, run the docs typecheck and production build, then start the docs server and confirm the changed route renders before handoff.',
    ),
    instructionsMd: withSharedDeliveryInstructions(
      `
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
- When \`sources/fumadocs\` exists, treat it as the source of truth for Fumadocs structure, conventions, and examples.
- When \`sources/fumadocs\` is absent, fall back to the installed Fumadocs packages in the docs app and the official Fumadocs docs for framework guidance.
- Identify the audience for the requested document before writing.
- Inside the prepared docs app, use \`bun\` for install, dev, typecheck, preview, and build commands.
- Before handoff, run \`bun run types:check\` inside the docs app and fix any MDX, route, or type errors.
- Before handoff, run \`bun run build\` inside the docs app and fix any static generation, prerender, or build failures.
- After the build passes, start the docs app with \`bun run dev\` or \`bun run preview\` and verify the changed docs route actually renders so the user can see the page without runtime errors.
- If the docs route fails to render, keep iterating until the page is reachable and the visible content matches the code.
- Keep prose direct, concrete, and easy to scan.
- Load the BuddyPie skills below when they match the task.

## BuddyPie Skills

- \`buddypie-docs-structure\` for README, guide, and architecture-document planning.
- \`buddypie-docs-qa\` for factual verification and editorial cleanup before handoff.
`.trim(),
    ),
    starterPrompt:
      'Review the current repository, identify the documentation gaps that matter most, and build a complete Fumadocs docs pass for this project. Cover the docs landing page, getting started and local setup, architecture and major subsystems, environment and configuration, development workflow, deployment or operations, and any API or integration docs that the codebase supports. Outline the structure before editing, then write or update the docs app content using the prepared Fumadocs workspace. Validate the result with Bun inside the docs app by running the typecheck, the production build, and then a local docs server so you confirm the updated route actually loads.',
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

export type OpenCodeAgentPresetId = keyof typeof openCodePresetMap
export type OpenCodeAgentPreset = OpenCodeAgentPresetDefinition & {
  id: OpenCodeAgentPresetId
}

export const defaultOpenCodeAgentPresetId: OpenCodeAgentPresetId =
  'general-engineer'

export const openCodeAgentPresets = Object.values(
  openCodePresetMap,
) as Array<OpenCodeAgentPreset>

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
