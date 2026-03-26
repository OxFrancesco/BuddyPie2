# BuddyPie

BuddyPie spins up cloud sandboxes, clones your repo, drops an AI coding agent inside, and lets you watch it work through a browser-based IDE. You pick a repo, choose a workflow preset, and BuddyPie handles the rest: provisioning the Daytona sandbox, checking out a dedicated branch, booting OpenCode, and seeding the first task.

Three payment rails sit behind a single launch button. Pay with subscription credits, settle per-session with x402 micropayments on Base, or set up a delegated USDC budget through a Solidity contract so the backend can draw from an approved allowance without a wallet prompt every time.

## How it works

1. You sign in (Clerk), land on the dashboard, pick a GitHub repo and a workflow preset.
2. BuddyPie creates a Daytona sandbox, clones the repo, checks out a `codex/...` working branch.
3. The selected preset writes its agent prompt, instructions, and skills into the sandbox, then starts OpenCode's web UI.
4. The agent begins working on whatever task you typed in, or falls back to the preset's built-in starter prompt.
5. You watch, interact, or walk away. When the agent finishes, it pushes the branch so you can open a PR.

## Stack

| Layer | What |
|---|---|
| Frontend | React 19, TanStack Router + Start, Tailwind CSS 4, Radix UI, shadcn/ui |
| Backend | Convex (realtime DB, mutations, queries, cron jobs, HTTP actions) |
| Auth | Clerk (JWT-based, synced to Convex) |
| Sandboxes | Daytona SDK |
| AI agent | OpenCode (embedded web IDE + agent runtime) |
| Payments | Clerk subscriptions, x402 micropayments (Base), delegated USDC budgets (MetaMask Delegation Toolkit) |
| Contracts | Foundry, Solidity, deployed on Base Sepolia / Base Mainnet |
| Docs site | Fumadocs (TanStack Start template) |

## Workflow presets

Each preset controls the agent's system prompt, managed instructions, injected skills, and workspace bootstrap behavior.

- **general-engineer** -- Full-stack product work. Inspects the repo first, plans small, verifies before handoff. Default model: OpenRouter `minimax/minimax-m2.7`.
- **frontend-builder** -- UI-focused. Prioritizes design-system consistency, responsive behavior, accessibility, and state coverage. Default model: OpenRouter `minimax/minimax-m2.7`.
- **docs-writer** -- Documentation from code. Clones the Fumadocs reference repo, scaffolds a docs app, writes content anchored to actual source files, then typechecks and builds before handing off. Default model: Venice `minimax-m27`.
- **nansen-analyst** -- Nansen CLI-powered onchain research. Uses Nansen commands for wallet, token, and smart-money analysis, and can publish ephemeral artifact UIs in the sandbox side panel for temporary visual summaries. Default model: Venice `minimax-m27`.

Every preset injects a shared delivery workflow: use Bun, run the build and typecheck, fix what you broke, push the branch when GitHub auth is available.

## Model options

| Provider | Model | Dashboard ID |
|---|---|---|
| OpenRouter | MiniMax M2.7 | `openrouter-minimax-m2.7` |
| Venice AI | GPT-5.3 Codex | `venice-gpt-5.3-codex` |
| Venice AI | Claude Sonnet 4.6 | `venice-claude-sonnet-4.6` |
| Venice AI | MiniMax M2.7 | `venice-minimax-m2.7` |

The preset and model are independent choices. You can run the docs-writer preset on GPT-5.3 Codex if you want.

## Billing

BuddyPie tracks credits, holds, charges, and ledger entries in Convex. Three payment methods:

- **Credits** -- Granted by Clerk subscription plans. Held at launch, captured or released on completion.
- **x402** -- Per-request micropayment settled on Base using the x402 protocol. No prepaid balance needed.
- **Delegated budget** -- You sign a MetaMask delegation that creates an onchain USDC budget. The `BuddyPieDelegatedBudgetSettlement` contract lets the backend settle charges against that budget without prompting your wallet each time. Fixed or periodic (daily/weekly/monthly) budgets supported.

## Required environment

```
CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
CLERK_JWT_ISSUER_DOMAIN
VITE_CONVEX_URL
DAYTONA_API_KEY
```

Optional:

```
DAYTONA_API_URL
CONVEX_SITE_URL
OPENROUTER_API_KEY          # needed for OpenRouter model options
VENICE_API_KEY              # needed for Venice model options
NANSEN_API_KEY              # needed for the Nansen Analyst preset
X402_PAY_TO_ADDRESS         # Convex env, for x402 settlement
X402_EIP712_TOKEN_NAME      # Convex env, if overriding USDC asset
X402_EIP712_TOKEN_VERSION   # Convex env, if overriding USDC asset
```

Follow the [Clerk + Convex auth guide](https://docs.convex.dev/auth/clerk) and make sure `convex/auth.config.ts` uses the matching Clerk issuer domain.

## Development

```bash
bun install
bunx convex dev --once
bun run dev
```

This starts the Vite dev server, Convex watcher, and the Fumadocs dev server concurrently.

## Contracts

The delegated budget settlement contract lives in `contracts/src/BuddyPieDelegatedBudgetSettlement.sol`. Deploy with Foundry:

```bash
# Base Sepolia
forge script contracts/script/DeployDelegatedBudgetBaseSepolia.s.sol:DeployDelegatedBudgetBaseSepolia \
  --rpc-url https://sepolia.base.org --broadcast

# Base Mainnet
forge script contracts/script/DeployDelegatedBudgetBaseMainnet.s.sol:DeployDelegatedBudgetBaseMainnet \
  --rpc-url https://mainnet.base.org --broadcast
```

Add `--verify --etherscan-api-key "$ETHERSCAN_API_KEY"` for BaseScan verification.

## Project structure

```
src/
  components/       UI components (sandbox cards, billing, modals)
  features/         Feature modules (billing, sandboxes)
  lib/
    opencode/       Preset definitions, model catalog
    server/         Server-side Daytona, x402, delegated budget logic
    billing/        Client-side billing utilities
  routes/           TanStack Router pages (dashboard, profile, sandbox views)
convex/
  schema.ts         Full data model (users, sandboxes, billing, delegated budgets)
  billing.ts        Credit holds, charges, subscriptions, delegated budget mutations
  sandboxes.ts      Sandbox CRUD and lifecycle
  http.ts           Convex HTTP actions (webhooks, x402)
  crons.ts          Scheduled jobs (hold expiry, etc.)
contracts/
  src/              Solidity source
  script/           Foundry deploy scripts
  test/             Contract tests
docs/               Fumadocs documentation site
```

## Hackathon Submission

**Tracks:**
- 🎭 Venice — Private Agents, Trusted Actions (prizes: 1,000/600/400 VVV)
- 🦊 MetaMask — Best Use of Delegations ($3,000 / $1,500 / $500)
- 🌟 Synthesis Open Track — $28,133+ community pool

**Live Demo:** [agents.buddytools.org](https://agents.buddytools.org/) *(currently on testnet — users need whitelist access)*

**Showcase Video:** [https://x.com/Francesco_Oddo/status/2034994244503347594](https://x.com/Francesco_Oddo/status/2034994244503347594)

**Repo:** [github.com/oxfrancesco/buddypie2](https://github.com/oxfrancesco/buddypie2)

### Submission Metadata

| Field | Value |
|---|---|
| agentFramework | OpenCode (AI agent runtime) |
| agentHarness | openclaw |
| model | minimax-m2.7, venice-gpt-5.3-codex, venice-claude-sonnet-4.6, venice-minimax-m2.7 |
| skills | convex, shadcn, cloudflare, deploying-contracts-on-base, frontend-design, find-docs |
| tools | React 19, TanStack Router/Start, Convex, Clerk, Daytona SDK, OpenCode SDK, MetaMask Delegation Toolkit, x402, Viem, Foundry/Solidity, Base chain, Tailwind CSS 4, Radix UI, shadcn/ui, Fumadocs |
| helpfulResources | Convex docs, MetaMask Delegation Toolkit docs, x402 protocol docs, Daytona SDK docs, Clerk + Convex auth guide |

## TL;DR

BuddyPie gives you a one-click AI coding session on any repo. Pick a repo, pick a preset, hit launch. The sandbox boots, the agent reads the codebase, does the work, and pushes a branch you can PR from.

What makes it worth your time:

- The agent actually runs in an isolated cloud sandbox with real tooling, not a chat window pretending to write code.
- Three presets (general engineering, frontend, docs) that ship with real instructions, skills, and workspace bootstrapping instead of a generic "you are a helpful assistant" prompt.
- You choose the model. Swap between OpenRouter and Venice, between MiniMax, GPT-5.3 Codex, and Claude Sonnet 4.6. The preset and the model are independent knobs.
- Billing that doesn't get in the way. Subscription credits for teams that want a monthly budget, x402 micropayments for pay-as-you-go, and onchain delegated budgets for people who want to approve a spending cap once and forget about it.
- The docs-writer preset doesn't just generate markdown. It scaffolds a full Fumadocs site, cross-references the actual source code, typechecks, builds, and confirms the pages render before it calls the job done.
- Every session lands on a dedicated branch. The agent stays on it, pushes when done, and you open a PR when you're ready.
