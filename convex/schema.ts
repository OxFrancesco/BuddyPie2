import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    lastSeenAt: v.number(),
  })
    .index('by_token_identifier', ['tokenIdentifier'])
    .index('by_clerk_user_id', ['clerkUserId']),

  sandboxes: defineTable({
    userId: v.id('users'),
    repoUrl: v.string(),
    repoName: v.string(),
    repoBranch: v.optional(v.string()),
    repoProvider: v.union(v.literal('github'), v.literal('git')),
    agentPresetId: v.optional(v.string()),
    agentLabel: v.optional(v.string()),
    agentProvider: v.optional(v.string()),
    agentModel: v.optional(v.string()),
    initialPrompt: v.optional(v.string()),
    status: v.union(
      v.literal('creating'),
      v.literal('ready'),
      v.literal('failed'),
    ),
    daytonaSandboxId: v.optional(v.string()),
    opencodeSessionId: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    previewUrlPattern: v.optional(v.string()),
    workspacePath: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    agentReserveId: v.optional(v.id('agentReserves')),
    launchLeaseId: v.optional(v.id('reserveLeases')),
    billedUsdCents: v.optional(v.number()),
    lastBilledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user_and_created_at', ['userId', 'createdAt']),

  billingAccounts: defineTable({
    userId: v.id('users'),
    currency: v.literal('USD'),
    fundingAsset: v.literal('USDC'),
    fundingNetwork: v.literal('base-sepolia'),
    fundedUsdCents: v.number(),
    unallocatedUsdCents: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user_and_currency', ['userId', 'currency']),

  fundingTransactions: defineTable({
    userId: v.id('users'),
    accountId: v.id('billingAccounts'),
    source: v.union(v.literal('manual_testnet'), v.literal('x402_settled')),
    status: v.literal('settled'),
    paymentReference: v.string(),
    idempotencyKey: v.string(),
    network: v.literal('base-sepolia'),
    asset: v.literal('USDC'),
    grossUsdCents: v.number(),
    grossTokenAmount: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    createdAt: v.number(),
    settledAt: v.number(),
  })
    .index('by_account_and_created_at', ['accountId', 'createdAt'])
    .index('by_idempotency_key', ['idempotencyKey']),

  agentReserves: defineTable({
    userId: v.id('users'),
    accountId: v.id('billingAccounts'),
    agentPresetId: v.string(),
    currency: v.literal('USD'),
    environment: v.literal('prod'),
    allocatedUsdCents: v.number(),
    availableUsdCents: v.number(),
    heldUsdCents: v.number(),
    spentUsdCentsLifetime: v.number(),
    lowBalanceThresholdUsdCents: v.number(),
    status: v.union(
      v.literal('active'),
      v.literal('paused'),
      v.literal('closed'),
    ),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_and_agent_preset_id', ['userId', 'agentPresetId'])
    .index('by_account_and_agent_preset_id', ['accountId', 'agentPresetId']),

  reserveLeases: defineTable({
    userId: v.id('users'),
    accountId: v.id('billingAccounts'),
    agentReserveId: v.id('agentReserves'),
    sandboxId: v.optional(v.id('sandboxes')),
    workerKey: v.string(),
    purpose: v.union(
      v.literal('sandbox_launch'),
      v.literal('preview_boot'),
      v.literal('ssh_access'),
      v.literal('web_terminal'),
      v.literal('generic'),
    ),
    amountUsdCents: v.number(),
    status: v.union(
      v.literal('active'),
      v.literal('captured'),
      v.literal('released'),
      v.literal('expired'),
    ),
    expiresAt: v.number(),
    idempotencyKey: v.string(),
    metadataJson: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_and_status', ['userId', 'status'])
    .index('by_agent_reserve_and_status', ['agentReserveId', 'status'])
    .index('by_status_and_expires_at', ['status', 'expiresAt'])
    .index('by_idempotency_key', ['idempotencyKey']),

  usageEvents: defineTable({
    userId: v.id('users'),
    accountId: v.id('billingAccounts'),
    agentReserveId: v.id('agentReserves'),
    sandboxId: v.optional(v.id('sandboxes')),
    leaseId: v.optional(v.id('reserveLeases')),
    eventType: v.union(
      v.literal('sandbox_launch'),
      v.literal('preview_boot'),
      v.literal('ssh_access'),
      v.literal('web_terminal'),
    ),
    quantitySummary: v.optional(v.string()),
    description: v.string(),
    costUsdCents: v.number(),
    unitPriceVersion: v.string(),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index('by_sandbox_and_created_at', ['sandboxId', 'createdAt'])
    .index('by_agent_reserve_and_created_at', ['agentReserveId', 'createdAt'])
    .index('by_idempotency_key', ['idempotencyKey']),

  ledgerEntries: defineTable({
    userId: v.id('users'),
    accountId: v.id('billingAccounts'),
    agentReserveId: v.optional(v.id('agentReserves')),
    sandboxId: v.optional(v.id('sandboxes')),
    leaseId: v.optional(v.id('reserveLeases')),
    usageEventId: v.optional(v.id('usageEvents')),
    referenceType: v.union(
      v.literal('funding'),
      v.literal('allocation'),
      v.literal('lease_hold'),
      v.literal('lease_release'),
      v.literal('usage_debit'),
    ),
    direction: v.union(v.literal('debit'), v.literal('credit')),
    bucket: v.union(
      v.literal('funding_unallocated'),
      v.literal('reserve_available'),
      v.literal('reserve_held'),
      v.literal('revenue'),
    ),
    amountUsdCents: v.number(),
    description: v.string(),
    createdAt: v.number(),
  })
    .index('by_user_and_created_at', ['userId', 'createdAt'])
    .index('by_account_and_created_at', ['accountId', 'createdAt']),
})
