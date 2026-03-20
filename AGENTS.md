Make sure to use bun!

If you change OpenCode providers, models, or defaults, update `models.md`,
`README.md`, and this file in the same change.

Keep the provider/model catalog in `src/lib/opencode/presets.ts` aligned with
the values BuddyPie persists to Convex as `agentProvider` and `agentModel`.

Kickoff prompt defaults matter too: leaving the dashboard kickoff field blank
should always seed OpenCode with the preset's built-in starter prompt, so keep
each shipping preset's `starterPrompt` non-empty unless the product behavior is
intentionally changing and the docs above are updated with it.
