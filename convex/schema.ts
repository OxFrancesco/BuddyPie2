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
    billingAccountId: v.optional(v.id('creditAccounts')),
    launchHoldId: v.optional(v.id('creditHolds')),
    pendingPaymentMethod: v.optional(
      v.union(
        v.literal('credits'),
        v.literal('x402'),
        v.literal('delegated_budget'),
      ),
    ),
    lastChargeId: v.optional(v.id('billingCharges')),
    billedUsdCents: v.optional(v.number()),
    lastBilledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user_and_created_at', ['userId', 'createdAt']),

  creditAccounts: defineTable({
    userId: v.id('users'),
    currency: v.literal('USD'),
    environment: v.union(v.literal('staging'), v.literal('production')),
    fundingAsset: v.literal('USDC'),
    fundingNetwork: v.union(
      v.literal('base-sepolia'),
      v.literal('base-mainnet'),
    ),
    availableUsdCents: v.number(),
    heldUsdCents: v.number(),
    lifetimeCreditedUsdCents: v.number(),
    lifetimeSpentUsdCents: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user_and_environment', ['userId', 'environment']),

  creditHolds: defineTable({
    userId: v.id('users'),
    accountId: v.id('creditAccounts'),
    sandboxId: v.optional(v.id('sandboxes')),
    agentPresetId: v.string(),
    purpose: v.union(
      v.literal('sandbox_launch'),
      v.literal('preview_boot'),
      v.literal('ssh_access'),
      v.literal('web_terminal'),
      v.literal('generic'),
    ),
    amountUsdCents: v.number(),
    sourcePaymentRail: v.union(
      v.literal('clerk_credit'),
      v.literal('migration'),
      v.literal('manual_test'),
    ),
    status: v.union(
      v.literal('active'),
      v.literal('captured'),
      v.literal('released'),
      v.literal('expired'),
    ),
    expiresAt: v.number(),
    idempotencyKey: v.string(),
    migrationReference: v.optional(v.string()),
    quantitySummary: v.optional(v.string()),
    description: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    capturedAt: v.optional(v.number()),
    releasedAt: v.optional(v.number()),
  })
    .index('by_account_and_status', ['accountId', 'status'])
    .index('by_status_and_expires_at', ['status', 'expiresAt'])
    .index('by_idempotency_key', ['idempotencyKey'])
    .index('by_migration_reference', ['migrationReference']),

  billingCharges: defineTable({
    userId: v.id('users'),
    accountId: v.optional(v.id('creditAccounts')),
    sandboxId: v.optional(v.id('sandboxes')),
    holdId: v.optional(v.id('creditHolds')),
    agentPresetId: v.string(),
    eventType: v.union(
      v.literal('sandbox_launch'),
      v.literal('preview_boot'),
      v.literal('ssh_access'),
      v.literal('web_terminal'),
    ),
    paymentRail: v.union(
      v.literal('clerk_credit'),
      v.literal('x402_direct'),
      v.literal('metamask_delegated'),
      v.literal('migration'),
      v.literal('manual_test'),
    ),
    amountUsdCents: v.number(),
    unitPriceVersion: v.string(),
    quantitySummary: v.optional(v.string()),
    description: v.string(),
    idempotencyKey: v.string(),
    externalReference: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_user_and_created_at', ['userId', 'createdAt'])
    .index('by_account_and_created_at', ['accountId', 'createdAt'])
    .index('by_sandbox_and_created_at', ['sandboxId', 'createdAt'])
    .index('by_hold_id', ['holdId'])
    .index('by_idempotency_key', ['idempotencyKey']),

  creditLedgerEntries: defineTable({
    userId: v.id('users'),
    accountId: v.id('creditAccounts'),
    sandboxId: v.optional(v.id('sandboxes')),
    holdId: v.optional(v.id('creditHolds')),
    chargeId: v.optional(v.id('billingCharges')),
    paymentRail: v.union(
      v.literal('clerk_credit'),
      v.literal('x402_direct'),
      v.literal('metamask_delegated'),
      v.literal('migration'),
      v.literal('manual_test'),
    ),
    referenceType: v.union(
      v.literal('migration_opening'),
      v.literal('subscription_grant'),
      v.literal('manual_grant'),
      v.literal('hold_created'),
      v.literal('hold_released'),
      v.literal('hold_captured'),
      v.literal('x402_charge'),
      v.literal('delegated_budget_charge'),
    ),
    amountUsdCents: v.number(),
    balanceDeltaAvailableUsdCents: v.number(),
    balanceDeltaHeldUsdCents: v.number(),
    description: v.string(),
    createdAt: v.number(),
  })
    .index('by_user_and_created_at', ['userId', 'createdAt'])
    .index('by_account_and_created_at', ['accountId', 'createdAt']),

  clerkSubscriptionSnapshots: defineTable({
    userId: v.id('users'),
    clerkUserId: v.string(),
    clerkSubscriptionId: v.string(),
    clerkSubscriptionItemId: v.optional(v.string()),
    status: v.union(
      v.literal('active'),
      v.literal('past_due'),
      v.literal('canceled'),
      v.literal('ended'),
      v.literal('abandoned'),
      v.literal('incomplete'),
      v.literal('upcoming'),
    ),
    planSlug: v.optional(v.string()),
    planName: v.optional(v.string()),
    planPeriod: v.optional(v.union(v.literal('month'), v.literal('annual'))),
    payerType: v.literal('user'),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    rawJson: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_and_updated_at', ['userId', 'updatedAt'])
    .index('by_clerk_subscription_id', ['clerkSubscriptionId']),

  subscriptionCreditGrants: defineTable({
    userId: v.id('users'),
    accountId: v.id('creditAccounts'),
    clerkSubscriptionId: v.string(),
    clerkSubscriptionItemId: v.string(),
    planSlug: v.optional(v.string()),
    planPeriod: v.optional(v.union(v.literal('month'), v.literal('annual'))),
    paymentRail: v.literal('clerk_credit'),
    amountUsdCents: v.number(),
    periodStart: v.number(),
    periodEnd: v.optional(v.number()),
    idempotencyKey: v.string(),
    snapshotId: v.optional(v.id('clerkSubscriptionSnapshots')),
    createdAt: v.number(),
    appliedAt: v.number(),
  })
    .index('by_account_and_created_at', ['accountId', 'createdAt'])
    .index('by_idempotency_key', ['idempotencyKey']),

  delegatedBudgets: defineTable({
    userId: v.id('users'),
    accountId: v.optional(v.id('creditAccounts')),
    status: v.union(
      v.literal('active'),
      v.literal('revoked'),
      v.literal('expired'),
      v.literal('pending'),
    ),
    budgetType: v.union(v.literal('fixed'), v.literal('periodic')),
    interval: v.optional(
      v.union(v.literal('day'), v.literal('week'), v.literal('month')),
    ),
    token: v.literal('USDC'),
    network: v.union(
      v.literal('base-sepolia'),
      v.literal('base-mainnet'),
    ),
    configuredAmountUsdCents: v.number(),
    remainingAmountUsdCents: v.number(),
    periodStartedAt: v.optional(v.number()),
    periodEndsAt: v.optional(v.number()),
    ownerAddress: v.string(),
    delegatorSmartAccount: v.string(),
    delegateAddress: v.string(),
    treasuryAddress: v.optional(v.string()),
    settlementContract: v.optional(v.string()),
    contractBudgetId: v.string(),
    delegationJson: v.string(),
    delegationHash: v.string(),
    delegationExpiresAt: v.optional(v.number()),
    approvalMode: v.union(v.literal('exact'), v.literal('standing')),
    approvalTxHash: v.optional(v.string()),
    createTxHash: v.optional(v.string()),
    lastSettlementAt: v.optional(v.number()),
    lastSettlementTxHash: v.optional(v.string()),
    lastRevokedAt: v.optional(v.number()),
    revokeTxHash: v.optional(v.string()),
    revocationMode: v.optional(
      v.union(v.literal('onchain'), v.literal('local_retire')),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user_and_created_at', ['userId', 'createdAt'])
    .index('by_user_and_status', ['userId', 'status'])
    .index('by_contract_budget_id', ['contractBudgetId']),

  delegatedBudgetSettlements: defineTable({
    userId: v.id('users'),
    delegatedBudgetId: v.id('delegatedBudgets'),
    sandboxId: v.optional(v.id('sandboxes')),
    chargeId: v.optional(v.id('billingCharges')),
    agentPresetId: v.string(),
    eventType: v.union(
      v.literal('sandbox_launch'),
      v.literal('preview_boot'),
      v.literal('ssh_access'),
      v.literal('web_terminal'),
    ),
    paymentRail: v.literal('metamask_delegated'),
    amountUsdCents: v.number(),
    contractBudgetId: v.string(),
    settlementId: v.string(),
    txHash: v.string(),
    remainingAmountUsdCents: v.number(),
    periodStartedAt: v.optional(v.number()),
    periodEndsAt: v.optional(v.number()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index('by_user_and_created_at', ['userId', 'createdAt'])
    .index('by_budget_and_created_at', ['delegatedBudgetId', 'createdAt'])
    .index('by_charge_id', ['chargeId'])
    .index('by_idempotency_key', ['idempotencyKey']),

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
    source: v.union(
      v.literal('manual_testnet'),
      v.literal('x402_settled'),
      v.literal('wallet_user_settled'),
    ),
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
