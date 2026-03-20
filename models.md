# Model Providers And Models

This file is the source of truth for the OpenCode model providers and model
options BuddyPie exposes in the dashboard.

## Current Provider And Model Options

### OpenRouter

- Provider id: `openrouter`
- Required env: `OPENROUTER_API_KEY`
- Current model option: `minimax/minimax-m2.7`
- Where it is selectable: the dashboard model selector

### Venice AI

- Provider id: `venice`
- Required env: `VENICE_API_KEY`
- Current model options:
  - `openai-gpt-53-codex`
  - `claude-sonnet-4-6`
  - `zai-org-glm-5`
- Where it is selectable: the dashboard model selector

## Workflow Presets

Workflow presets are separate from provider/model selection.

- `general-engineer`
- `frontend-builder`
- `docs-writer`

Current preset defaults:

- `general-engineer` -> OpenRouter `minimax/minimax-m2.7`
- `frontend-builder` -> OpenRouter `minimax/minimax-m2.7`
- `docs-writer` -> Venice `zai-org-glm-5`

The selected workflow preset controls instructions, skills, workspace
bootstrap, and kickoff behavior.

Kickoff default behavior:

- leaving the dashboard kickoff field blank uses the preset starter prompt
- every current preset, including `general-engineer`, is expected to keep a
  non-empty starter prompt so BuddyPie can seed the first OpenCode session

The selected provider/model controls which OpenCode provider and model are
used at runtime.

## Where To Change Provider Or Model Options

Change the supported provider/model catalog in
`src/lib/opencode/presets.ts`.

This currently drives:

- the dashboard launch selector
- launch-time validation in `src/lib/sandboxes.ts`
- Daytona/OpenCode runtime setup in `src/lib/server/daytona.ts`
- restart behavior through the stored Convex sandbox record

## Convex Persistence

BuddyPie stores the selected runtime values in the `sandboxes` table:

- `agentPresetId`
- `agentLabel`
- `agentProvider`
- `agentModel`

These fields are defined in `convex/schema.ts` and written through
`convex/sandboxes.ts`.

## Every Time We Change Providers Or Models

When adding, removing, or changing a provider/model option:

1. Update `src/lib/opencode/presets.ts`.
2. Update this file.
3. Update `README.md`.
4. Update `AGENTS.md`.
5. Verify the needed env vars are documented and available.
6. Confirm launch and restart still preserve the intended `agentProvider` and
   `agentModel` in Convex.
