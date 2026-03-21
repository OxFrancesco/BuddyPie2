import {
  ExecutionMode,
  contracts,
  createExecution,
  getDeleGatorEnvironment,
  redeemDelegations,
  type Delegation,
} from '@metamask/delegation-toolkit'
import { hashDelegation } from '@metamask/delegation-core'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import {
  contractEnumToDelegatedBudgetInterval,
  contractEnumToDelegatedBudgetType,
  delegatedBudgetContractAbi,
  erc20BalanceAbi,
  type DelegatedBudgetInterval,
  type DelegatedBudgetType,
  usdCentsToUsdcAtomic,
} from '~/lib/billing/delegated-budget-contract'
import {
  formatUsdCents,
  getBillingEnvironmentConfig,
  getDelegatedBudgetEnvironmentConfig,
  readBillingEnvironmentScopedValue,
} from '../../../convex/lib/billingConfig'

type ChainConfig = typeof base | typeof baseSepolia

type SignerServiceConfig = {
  url: string
  bearerToken: string | null
}

type DelegatedBudgetStatus = 'active' | 'revoked' | 'expired' | 'pending'
export type DelegatedBudgetHealth = 'usable' | 'needs_recreate'
export type DelegatedBudgetHealthReason =
  | 'revoked'
  | 'expired'
  | 'undeployed_smart_account'
  | 'delegate_mismatch'
  | 'treasury_mismatch'
  | 'missing_treasury'
  | 'legacy_transfer_caveat'
  | 'invalid_delegation'
  | 'unknown'

export type DelegatedBudgetRecordInput = {
  status?: DelegatedBudgetStatus
  budgetType: DelegatedBudgetType
  interval?: DelegatedBudgetInterval
  configuredAmountUsdCents: number
  ownerAddress: string
  delegatorSmartAccount: string
  delegateAddress: string
  treasuryAddress?: string
  settlementContract?: string
  contractBudgetId: string
  delegationJson: string
  delegationHash: string
  delegationExpiresAt?: number
  periodStartedAt?: number
  periodEndsAt?: number
  lastSettlementAt?: number
  lastRevokedAt?: number
}

export type DelegatedBudgetOnchainState = {
  status: 'active' | 'revoked' | 'expired'
  budgetType: DelegatedBudgetType
  interval: DelegatedBudgetInterval | null
  configuredAmountUsdCents: number
  remainingAmountUsdCents: number
  ownerAddress: Address
  delegateAddress: Address
  delegatorSmartAccount: Address
  periodStartedAt: number | null
  periodEndsAt: number | null
  lastSettlementAt: number | null
  lastRevokedAt: number | null
}

export type DelegatedBudgetHealthState = {
  health: DelegatedBudgetHealth
  healthReason: DelegatedBudgetHealthReason
  message: string
  budget: DelegatedBudgetOnchainState | null
}

function resolveDelegatedBudgetChain(): ChainConfig {
  const billing = getBillingEnvironmentConfig()
  return billing.chainId === 8453 ? base : baseSepolia
}

function resolveRpcUrl(chain: ChainConfig) {
  return (
    readBillingEnvironmentScopedValue('DELEGATED_BUDGET_RPC_URL') ||
    readBillingEnvironmentScopedValue('BASE_RPC_URL') ||
    chain.rpcUrls.default.http[0]
  )
}

function readSignerServiceEnvironmentValue(baseName: string) {
  const environment = getBillingEnvironmentConfig().environment
  const scopedName =
    environment === 'production' ? `${baseName}_PROD` : `${baseName}_STG`

  return process.env[scopedName]?.trim() || process.env[baseName]?.trim() || ''
}

function resolveSignerServiceConfig(): SignerServiceConfig | null {
  const url = readSignerServiceEnvironmentValue('DB_SIGNER_URL')

  if (!url) {
    return null
  }

  return {
    url,
    bearerToken: readSignerServiceEnvironmentValue('DB_SIGNER_TOKEN') || null,
  }
}

function resolveBackendDelegatePrivateKey() {
  if (getBillingEnvironmentConfig().environment === 'production') {
    throw new Error(
      'Production delegated-budget settlement requires a dedicated signer service. Configure DB_SIGNER_URL_PROD instead of loading a backend private key into the app.',
    )
  }

  const privateKey =
    readBillingEnvironmentScopedValue('DELEGATED_BUDGET_BACKEND_PRIVATE_KEY') ||
    process.env.EVM_PRIVATE_KEY?.trim() ||
    ''

  if (!privateKey) {
    throw new Error(
      'Set DB_BACKEND_PK_STG before using delegated budgets outside production.',
    )
  }

  return privateKey as Hex
}

function createOnchainReadContext() {
  const delegatedBudget = getDelegatedBudgetEnvironmentConfig()

  if (!delegatedBudget.enabled) {
    throw new Error('Delegated budgets are not configured in this environment.')
  }

  const chain = resolveDelegatedBudgetChain()
  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(chain)),
  })

  return {
    chain,
    delegatedBudget,
    environment: getDeleGatorEnvironment(chain.id),
    publicClient,
  }
}

function createLocalOnchainClients() {
  const readContext = createOnchainReadContext()
  const delegateAccount = privateKeyToAccount(resolveBackendDelegatePrivateKey())

  if (
    getAddress(delegateAccount.address) !==
    getAddress(readContext.delegatedBudget.backendDelegateAddress as Address)
  ) {
    throw new Error(
      'The configured delegated-budget backend private key does not match the configured backend delegate address.',
    )
  }

  const walletClient = createWalletClient({
    account: delegateAccount,
    chain: readContext.chain,
    transport: http(resolveRpcUrl(readContext.chain)),
  })

  return {
    ...readContext,
    delegateAccount,
    walletClient,
  }
}

function resolveSettlementContractAddress(
  budget?: Pick<DelegatedBudgetRecordInput, 'settlementContract'>,
) {
  const configuredAddress =
    budget?.settlementContract?.trim() ||
    getDelegatedBudgetEnvironmentConfig().settlementContract

  if (!configuredAddress) {
    throw new Error(
      'The delegated budget settlement contract is not configured. Re-create the budget after configuring it.',
    )
  }

  return getAddress(configuredAddress as Address)
}

function isBudgetNotFoundError(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return /BudgetNotFound|budget not found|execution reverted/i.test(message)
}

function buildDelegatedBudgetHealthMessage(
  reason: DelegatedBudgetHealthReason,
) {
  switch (reason) {
    case 'revoked':
      return 'This delegated budget is no longer active. Reset and recreate it before using this payment rail.'
    case 'expired':
      return 'This delegated budget has expired. Reset and recreate it before using this payment rail.'
    case 'undeployed_smart_account':
      return 'The delegated budget smart account is not deployed onchain yet. Reset and recreate the budget so BuddyPie can deploy it first.'
    case 'delegate_mismatch':
      return 'This delegated budget was signed for a different backend delegate. Reset and recreate it before using this payment rail.'
    case 'treasury_mismatch':
      return 'This delegated budget points at a different treasury than BuddyPie uses now. Reset and recreate it before using this payment rail.'
    case 'missing_treasury':
      return 'This delegated budget is missing its treasury target. Reset and recreate it before using this payment rail.'
    case 'legacy_transfer_caveat':
      return "This delegated budget was created with an older ERC20 transfer caveat that does not work with BuddyPie's settlement-contract flow. Reset and recreate it before using this payment rail."
    case 'invalid_delegation':
      return 'The stored delegated-budget signature no longer matches its delegation payload. Reset and recreate it before using this payment rail.'
    default:
      return 'BuddyPie could not validate this delegated budget. Reset and recreate it before using this payment rail.'
  }
}

function atomicToUsdCents(value: bigint) {
  return Number(value / 10_000n)
}

function buildDelegatedBudgetFundingMessage(args: {
  balanceUsdCents: number
  requiredAmountUsdCents: number
  actionLabel: string
  smartAccountAddress: Address
}) {
  const chain = resolveDelegatedBudgetChain()

  return `Your MetaMask smart account only has ${formatUsdCents(args.balanceUsdCents)} USDC on ${chain.name}. Fund ${getAddress(args.smartAccountAddress)} before ${args.actionLabel} (${formatUsdCents(args.requiredAmountUsdCents)} required).`
}

function parseDelegation(delegationJson: string) {
  return JSON.parse(delegationJson) as Delegation
}

function computeDelegationHash(delegationJson: string) {
  return hashDelegation(parseDelegation(delegationJson) as never)
}

async function assertDeployedDelegatorSmartAccount(address: Address) {
  const { publicClient } = createOnchainReadContext()
  const code = await publicClient.getCode({
    address: getAddress(address),
  })

  if (!code || code === '0x') {
    throw new Error(
      'The delegated budget smart account is not deployed onchain. Re-create the budget after deploying the MetaMask smart account.',
    )
  }
}

async function isDelegatorSmartAccountDeployed(address: Address) {
  const { publicClient } = createOnchainReadContext()
  const code = await publicClient.getCode({
    address: getAddress(address),
  })

  return Boolean(code) && code !== '0x'
}

async function readDelegatorSmartAccountTokenBalanceAtomic(address: Address) {
  const { delegatedBudget, publicClient } = createOnchainReadContext()

  return await publicClient.readContract({
    address: delegatedBudget.tokenAddress as Address,
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [getAddress(address)],
  })
}

/** USDC balance of the MetaMask smart account (same funds used for x402), in USD cents. */
export async function readDelegatorSmartAccountUsdcUsdCents(
  delegatorSmartAccount: string,
): Promise<number | null> {
  try {
    const atomic = await readDelegatorSmartAccountTokenBalanceAtomic(
      getAddress(delegatorSmartAccount as Address),
    )
    return atomicToUsdCents(atomic)
  } catch {
    return null
  }
}

function normalizeDelegationHash(args: {
  delegationJson: string
  delegationHash?: string
}) {
  const computedHash = computeDelegationHash(args.delegationJson)

  if (args.delegationHash && args.delegationHash !== computedHash) {
    throw new Error(
      'The stored delegated-budget hash does not match the signed delegation payload.',
    )
  }

  return computedHash
}

function usesLegacyDelegatedBudgetTransferCaveat(args: {
  delegationJson: string
  environment: ReturnType<typeof getDeleGatorEnvironment>
}) {
  const delegation = parseDelegation(args.delegationJson)
  const legacyEnforcers = [
    args.environment.caveatEnforcers.ERC20TransferAmountEnforcer,
    args.environment.caveatEnforcers.ERC20PeriodTransferEnforcer,
  ]
    .filter(Boolean)
    .map((value) => getAddress(value as Address))

  return (delegation.caveats ?? []).some((caveat) => {
    try {
      return legacyEnforcers.includes(getAddress(caveat.enforcer as Address))
    } catch {
      return false
    }
  })
}

export function classifyDelegatedBudgetHealth(args: {
  budgetStatus?: DelegatedBudgetStatus
  delegationExpiresAt?: number
  delegateMatchesEnvironment: boolean
  treasuryMatchesEnvironment: boolean
  hasTreasuryAddress: boolean
  delegationHashMatches: boolean
  delegationExecutionCompatible?: boolean
  delegatorSmartAccountDeployed: boolean
  onchainStatus?: DelegatedBudgetOnchainState['status'] | null
  now?: number
}): {
  health: DelegatedBudgetHealth
  healthReason: DelegatedBudgetHealthReason
} {
  const now = args.now ?? Date.now()

  if (!args.delegationHashMatches) {
    return {
      health: 'needs_recreate',
      healthReason: 'invalid_delegation',
    }
  }

  if (!args.hasTreasuryAddress) {
    return {
      health: 'needs_recreate',
      healthReason: 'missing_treasury',
    }
  }

  if (args.delegationExecutionCompatible === false) {
    return {
      health: 'needs_recreate',
      healthReason: 'legacy_transfer_caveat',
    }
  }

  if (!args.delegateMatchesEnvironment) {
    return {
      health: 'needs_recreate',
      healthReason: 'delegate_mismatch',
    }
  }

  if (!args.treasuryMatchesEnvironment) {
    return {
      health: 'needs_recreate',
      healthReason: 'treasury_mismatch',
    }
  }

  if (args.budgetStatus === 'revoked' || args.onchainStatus === 'revoked') {
    return {
      health: 'needs_recreate',
      healthReason: 'revoked',
    }
  }

  if (
    args.budgetStatus === 'expired' ||
    args.onchainStatus === 'expired' ||
    (typeof args.delegationExpiresAt === 'number' &&
      args.delegationExpiresAt <= now)
  ) {
    return {
      health: 'needs_recreate',
      healthReason: 'expired',
    }
  }

  if (!args.delegatorSmartAccountDeployed) {
    return {
      health: 'needs_recreate',
      healthReason: 'undeployed_smart_account',
    }
  }

  return {
    health: 'usable',
    healthReason: 'unknown',
  }
}

async function isDelegationDisabled(delegationHash: Hex) {
  const { environment, publicClient } = createOnchainReadContext()

  return await contracts.DelegationManager.read.disabledDelegations({
    client: publicClient,
    contractAddress: environment.DelegationManager as Address,
    delegationHash,
  })
}

export async function readDelegatedBudgetHealth(
  budget: DelegatedBudgetRecordInput,
): Promise<DelegatedBudgetHealthState> {
  const environmentConfig = getDelegatedBudgetEnvironmentConfig()

  if (!environmentConfig.enabled) {
    return {
      health: 'needs_recreate',
      healthReason: 'unknown',
      message: 'Delegated budgets are not configured in this environment yet.',
      budget: null,
    }
  }

  const normalizedTreasury = budget.treasuryAddress?.trim()
    ? getAddress(budget.treasuryAddress as Address)
    : null
  const delegateMatchesEnvironment =
    getAddress(budget.delegateAddress as Address) ===
    getAddress(environmentConfig.backendDelegateAddress as Address)
  const treasuryMatchesEnvironment =
    normalizedTreasury !== null &&
    normalizedTreasury === getAddress(environmentConfig.treasuryAddress as Address)
  let delegationHashMatches = true
  let delegationExecutionCompatible = true

  try {
    delegationExecutionCompatible = !usesLegacyDelegatedBudgetTransferCaveat({
      delegationJson: budget.delegationJson,
      environment: getDeleGatorEnvironment(resolveDelegatedBudgetChain().id),
    })
  } catch {}

  try {
    normalizeDelegationHash({
      delegationJson: budget.delegationJson,
      delegationHash: budget.delegationHash,
    })
  } catch {
    delegationHashMatches = false
  }

  const deployed = await isDelegatorSmartAccountDeployed(
    budget.delegatorSmartAccount as Address,
  )
  const baseClassification = classifyDelegatedBudgetHealth({
    budgetStatus: budget.status,
    delegationExpiresAt: budget.delegationExpiresAt,
    delegateMatchesEnvironment,
    treasuryMatchesEnvironment,
    hasTreasuryAddress: Boolean(normalizedTreasury),
    delegationHashMatches,
    delegationExecutionCompatible,
    delegatorSmartAccountDeployed: deployed,
  })

  if (baseClassification.health !== 'usable') {
    return {
      ...baseClassification,
      message: buildDelegatedBudgetHealthMessage(baseClassification.healthReason),
      budget: null,
    }
  }

  try {
    const onchainBudget = await readDelegatedBudgetOnchain(budget)
    const onchainClassification = classifyDelegatedBudgetHealth({
      budgetStatus: budget.status,
      delegationExpiresAt: budget.delegationExpiresAt,
      delegateMatchesEnvironment,
      treasuryMatchesEnvironment,
      hasTreasuryAddress: Boolean(normalizedTreasury),
      delegationHashMatches,
      delegationExecutionCompatible,
      delegatorSmartAccountDeployed: deployed,
      onchainStatus: onchainBudget.status,
    })

    if (onchainClassification.health !== 'usable') {
      return {
        ...onchainClassification,
        message: buildDelegatedBudgetHealthMessage(
          onchainClassification.healthReason,
        ),
        budget: onchainBudget,
      }
    }

    return {
      health: 'usable',
      healthReason: 'unknown',
      message: 'Delegated budget is ready to use.',
      budget: onchainBudget,
    }
  } catch (error) {
    const message = isBudgetNotFoundError(error)
      ? 'This delegated budget was never created onchain or has been removed. Reset and recreate it before using this payment rail.'
      : error instanceof Error && error.message.trim()
        ? error.message
        : buildDelegatedBudgetHealthMessage('unknown')

    return {
      health: 'needs_recreate',
      healthReason: 'unknown',
      message,
      budget: null,
    }
  }
}

export function buildDelegatedBudgetSettlementId(idempotencyKey: string) {
  return keccak256(stringToHex(`settlement:${idempotencyKey}`))
}

export async function readDelegatedBudgetOnchain(
  budget: DelegatedBudgetRecordInput,
) {
  await assertDeployedDelegatorSmartAccount(
    budget.delegatorSmartAccount as Address,
  )
  const { publicClient } = createOnchainReadContext()
  const delegationHash = normalizeDelegationHash({
    delegationJson: budget.delegationJson,
    delegationHash: budget.delegationHash,
  })
  const disabled = await isDelegationDisabled(delegationHash)
  const settlementContract = resolveSettlementContractAddress(budget)
  const onchainBudget = await publicClient.readContract({
    address: settlementContract,
    abi: delegatedBudgetContractAbi,
    functionName: 'getBudget',
    args: [budget.contractBudgetId as Hex],
  })
  const expired =
    typeof budget.delegationExpiresAt === 'number' &&
    budget.delegationExpiresAt <= Date.now()

  return {
    status:
      disabled || budget.status === 'revoked' || onchainBudget.revoked
        ? 'revoked'
        : expired
          ? 'expired'
          : 'active',
    budgetType: contractEnumToDelegatedBudgetType(Number(onchainBudget.budgetType)),
    interval: contractEnumToDelegatedBudgetInterval(Number(onchainBudget.interval)),
    configuredAmountUsdCents: atomicToUsdCents(onchainBudget.configuredAmount),
    remainingAmountUsdCents: atomicToUsdCents(onchainBudget.remainingAmount),
    ownerAddress: getAddress(onchainBudget.owner),
    delegateAddress: getAddress(onchainBudget.delegate),
    delegatorSmartAccount: getAddress(onchainBudget.delegatorSmartAccount),
    periodStartedAt:
      onchainBudget.periodStartAt > 0n
        ? Number(onchainBudget.periodStartAt) * 1000
        : null,
    periodEndsAt:
      onchainBudget.periodEndsAt > 0n
        ? Number(onchainBudget.periodEndsAt) * 1000
        : null,
    lastSettlementAt:
      onchainBudget.lastSettlementAt > 0n
        ? Number(onchainBudget.lastSettlementAt) * 1000
        : null,
    lastRevokedAt:
      onchainBudget.lastRevokedAt > 0n
        ? Number(onchainBudget.lastRevokedAt) * 1000
        : null,
  } satisfies DelegatedBudgetOnchainState
}

export async function assertDelegatedBudgetAllowanceOrThrow(args: {
  budget: DelegatedBudgetRecordInput
  requiredAmountUsdCents: number
  actionLabel: string
}) {
  if (
    !Number.isInteger(args.requiredAmountUsdCents) ||
    args.requiredAmountUsdCents <= 0
  ) {
    throw new Error('Delegated budget allowance checks require a positive amount.')
  }

  const health = await readDelegatedBudgetHealth(args.budget)

  if (health.health !== 'usable' || !health.budget) {
    throw new Error(health.message)
  }

  const budget = health.budget

  if (budget.status !== 'active') {
    throw new Error(
      `Your delegated budget is ${budget.status}. Refresh or revoke it before ${args.actionLabel}.`,
    )
  }

  if (budget.remainingAmountUsdCents < args.requiredAmountUsdCents) {
    throw new Error(
      `Your delegated budget has only ${formatUsdCents(budget.remainingAmountUsdCents)} left, which is not enough for ${args.actionLabel} (${formatUsdCents(args.requiredAmountUsdCents)} required).`,
    )
  }

  const balanceAtomic = await readDelegatorSmartAccountTokenBalanceAtomic(
    budget.delegatorSmartAccount,
  )

  if (balanceAtomic < usdCentsToUsdcAtomic(args.requiredAmountUsdCents)) {
    throw new Error(
      buildDelegatedBudgetFundingMessage({
        balanceUsdCents: atomicToUsdCents(balanceAtomic),
        requiredAmountUsdCents: args.requiredAmountUsdCents,
        actionLabel: args.actionLabel,
        smartAccountAddress: budget.delegatorSmartAccount,
      }),
    )
  }

  return budget
}

function buildSettlementExecutionCallData(args: {
  contractBudgetId: string
  amountUsdCents: number
  settlementId: Hex
}) {
  return encodeFunctionData({
    abi: delegatedBudgetContractAbi,
    functionName: 'settleBudget',
    args: [
      args.contractBudgetId as Hex,
      args.settlementId,
      usdCentsToUsdcAtomic(args.amountUsdCents),
    ],
  })
}

async function submitDelegatedBudgetSettlementLocally(args: {
  contractBudgetId: string
  delegationJson: string
  amountUsdCents: number
  settlementId: Hex
  settlementContract: string
}) {
  const { environment, publicClient, walletClient } =
    createLocalOnchainClients()
  const callData = buildSettlementExecutionCallData({
    contractBudgetId: args.contractBudgetId,
    amountUsdCents: args.amountUsdCents,
    settlementId: args.settlementId,
  })
  const delegation = parseDelegation(args.delegationJson)
  let txHash: Hex

  try {
    txHash = await redeemDelegations(
      walletClient as never,
      publicClient as never,
      environment.DelegationManager as Address,
      [
        {
          permissionContext: [delegation],
          executions: [
            createExecution({
              target: getAddress(args.settlementContract as Address),
              callData,
              value: 0n,
            }),
          ],
          mode: ExecutionMode.SingleDefault,
        },
      ],
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : ''

    if (
      /erc20transferamountenforcer:invalid-execution-length|erc20periodtransferenforcer:invalid-execution-length/i.test(
        message,
      )
    ) {
      throw new Error(
        "This delegated budget was created with an older ERC20 transfer caveat and cannot settle sandbox charges through BuddyPie's settlement contract. Revoke it and create a new delegated budget.",
      )
    }

    throw error
  }
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  })

  if (receipt.status !== 'success') {
    throw new Error('Delegated-budget settlement transaction reverted.')
  }

  return txHash
}

async function submitDelegatedBudgetSettlementViaSignerService(args: {
  contractBudgetId: string
  delegationJson: string
  amountUsdCents: number
  settlementId: Hex
  settlementContract: string
  treasuryAddress: string
}) {
  const signerService = resolveSignerServiceConfig()

  if (!signerService) {
    throw new Error(
      'Production delegated-budget settlement requires DB_SIGNER_URL_PROD.',
    )
  }

  const { chain, delegatedBudget } = createOnchainReadContext()
  const response = await fetch(
    new URL('/delegated-budget/settlements', signerService.url),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signerService.bearerToken
          ? { Authorization: `Bearer ${signerService.bearerToken}` }
          : {}),
      },
      body: JSON.stringify({
        chainId: chain.id,
        rpcUrl: resolveRpcUrl(chain),
        tokenAddress: delegatedBudget.tokenAddress,
        settlementContract: args.settlementContract,
        treasuryAddress: args.treasuryAddress,
        contractBudgetId: args.contractBudgetId,
        delegationJson: args.delegationJson,
        amountUsdCents: args.amountUsdCents,
        settlementId: args.settlementId,
      }),
    },
  )

  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(
      message.trim() || `Signer service settlement failed (${response.status}).`,
    )
  }

  const payload = (await response.json()) as { txHash?: string }

  if (!payload.txHash) {
    throw new Error('Signer service did not return a settlement tx hash.')
  }

  return payload.txHash as Hex
}

export async function settleDelegatedBudgetOnchain(args: {
  budget: DelegatedBudgetRecordInput
  amountUsdCents: number
  idempotencyKey: string
}) {
  if (
    getAddress(args.budget.delegateAddress as Address) !==
    getAddress(
      getDelegatedBudgetEnvironmentConfig().backendDelegateAddress as Address,
    )
  ) {
    throw new Error(
      'The delegated budget was issued for a different backend delegate. Re-create the budget before charging it.',
    )
  }

  await assertDelegatedBudgetAllowanceOrThrow({
    budget: args.budget,
    requiredAmountUsdCents: args.amountUsdCents,
    actionLabel: 'settling a delegated-budget charge',
  })
  await assertDeployedDelegatorSmartAccount(
    args.budget.delegatorSmartAccount as Address,
  )

  const settlementId = buildDelegatedBudgetSettlementId(args.idempotencyKey)
  const settlementContract = resolveSettlementContractAddress(args.budget)
  const treasuryAddress =
    args.budget.treasuryAddress ||
    getDelegatedBudgetEnvironmentConfig().treasuryAddress

  if (!treasuryAddress) {
    throw new Error(
      'The delegated budget treasury address is missing. Re-create the budget before charging it.',
    )
  }

  let txHash: Hex

  try {
    txHash =
      getBillingEnvironmentConfig().environment === 'production'
        ? await submitDelegatedBudgetSettlementViaSignerService({
            contractBudgetId: args.budget.contractBudgetId,
            delegationJson: args.budget.delegationJson,
            amountUsdCents: args.amountUsdCents,
            settlementId,
            settlementContract,
            treasuryAddress,
          })
        : await submitDelegatedBudgetSettlementLocally({
            contractBudgetId: args.budget.contractBudgetId,
            delegationJson: args.budget.delegationJson,
            amountUsdCents: args.amountUsdCents,
            settlementId,
            settlementContract,
          })
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : 'Delegated-budget settlement failed.'

    if (/transfer amount exceeds balance/i.test(message)) {
      const balanceAtomic = await readDelegatorSmartAccountTokenBalanceAtomic(
        args.budget.delegatorSmartAccount as Address,
      )

      throw new Error(
        buildDelegatedBudgetFundingMessage({
          balanceUsdCents: atomicToUsdCents(balanceAtomic),
          requiredAmountUsdCents: args.amountUsdCents,
          actionLabel: 'settling a delegated-budget charge',
          smartAccountAddress: args.budget.delegatorSmartAccount as Address,
        }),
      )
    }

    throw error
  }
  const budget = await readDelegatedBudgetOnchain(args.budget)

  return {
    txHash,
    settlementId,
    budget,
  }
}
