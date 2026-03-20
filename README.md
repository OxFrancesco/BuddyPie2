# BuddyPie

BuddyPie launches Daytona sandboxes, clones a repository, and boots an
embedded OpenCode workspace for task-specific AI sessions.

## Required Environment

Add these values to your local `.env` before starting the app:

- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_JWT_ISSUER_DOMAIN`
- `VITE_CONVEX_URL`
- `DAYTONA_API_KEY`

Optional:

- `DAYTONA_API_URL`
- `CONVEX_SITE_URL` (explicit Convex HTTP actions URL, e.g. `https://<deployment>.convex.site`)
- `OPENROUTER_API_KEY` for OpenRouter-backed model selections
- `VENICE_API_KEY` for Venice-backed model selections

For x402 settlement in Convex HTTP actions, configure `X402_PAY_TO_ADDRESS`
in your Convex deployment environment.

Wallet-signed top-ups require the user to connect a browser wallet on Base
Sepolia and sign a USDC transfer transaction.

If you override the USDC asset contract, also configure
`X402_EIP712_TOKEN_NAME` and `X402_EIP712_TOKEN_VERSION` in Convex env so
buyer payload signing has the correct token domain.

Follow the Clerk + Convex auth guide at
https://docs.convex.dev/auth/clerk and make sure `convex/auth.config.ts`
uses the matching Clerk issuer domain.

## Development

```bash
bunx convex dev --once
bun run dev
```

## OpenCode Presets And Models

BuddyPie manages the OpenCode preset layer instead of leaving agent
selection to OpenCode itself.

- Workflow presets live in `src/lib/opencode/presets.ts`.
- Supported provider/model selections also live in
  `src/lib/opencode/presets.ts` and are documented in `models.md`.
- The dashboard lets you choose the workflow preset separately from the
  provider/model option.
- BuddyPie persists the selected `agentPresetId`, `agentProvider`, and
  `agentModel` into the Convex `sandboxes` table and reuses the stored
  provider/model on restart.
- When provider or model options change, update `models.md`, `README.md`,
  and `AGENTS.md` in the same change.

Current model selections:

- OpenRouter: `minimax/minimax-m2.7`
- Venice: `openai-gpt-53-codex`
- Venice: `claude-sonnet-4-6`
- Venice: `zai-org-glm-5`

Preset defaults:

- `general-engineer`: OpenRouter `minimax/minimax-m2.7`
- `frontend-builder`: OpenRouter `minimax/minimax-m2.7`
- `docs-writer`: Venice `zai-org-glm-5`

When a sandbox launches, BuddyPie writes the preset-specific OpenCode files
inside the sandbox, starts `opencode web`, then seeds the first session with
the selected kickoff task.

Leaving the kickoff field blank uses the preset's built-in starter prompt.
Every current preset, including `general-engineer`, now ships a non-empty
starter prompt, and BuddyPie opens the seeded OpenCode session directly in
the web UI instead of landing on the generic root view.

The `docs-writer` preset also performs a docs-specific workspace bootstrap
before OpenCode starts:

- clones `https://github.com/fuma-nama/fumadocs.git` into `sources/fumadocs`
  on branch `main`
- adds `sources/` to the target repository root `.gitignore`
- scaffolds a Bun-based Fumadocs app with the `tanstack-start` template into
  `docs/`, or `docs-site/` when `docs/` is already occupied by non-Fumadocs
  content
- appends the prepared workspace paths to the managed AGENTS instructions and
  seeded kickoff prompt so the docs agent uses the product repo for project
  truth and the Fumadocs repo for framework truth
