import { createDelegation } from '@metamask/delegation-toolkit'
import { hashDelegation } from '@metamask/delegation-core'
import type { Address, Hex } from 'viem'
import {
  encodeFunctionData,
  getAddress,
} from 'viem'
import {
  buildDelegatedBudgetId,
  contractEnumToDelegatedBudgetInterval,
  contractEnumToDelegatedBudgetType,
  delegatedBudgetContractAbi,
  delegatedBudgetIntervalToContractEnum,
  delegatedBudgetTypeToContractEnum,
  erc20ApprovalAbi,
  erc20BalanceAbi,
  erc20TransferAbi,
  getDelegatedBudgetApprovalAmount,
  type DelegatedBudgetInterval,
  type DelegatedBudgetType,
  usdCentsToUsdcAtomic,
} from '~/lib/billing/delegated-budget-contract'
import { formatUsdCents } from '~/lib/billing/format'

type DelegatedBudgetSetupArgs = {
  amountUsdCents: number
  budgetType: DelegatedBudgetType
  interval?: DelegatedBudgetInterval | null
  chainId: number
  backendDelegateAddress: string
  bundlerUrl: string
  settlementContract: string
  tokenAddress: string
  treasuryAddress: string
}

type DelegatedBudgetSetupResult = {
  contractBudgetId: string
  budgetType: DelegatedBudgetType
  interval?: DelegatedBudgetInterval | null
  configuredAmountUsdCents: number
  remainingAmountUsdCents: number
  periodStartedAt: number | null
  periodEndsAt: number | null
  ownerAddress: string
  delegatorSmartAccount: string
  delegateAddress: string
  treasuryAddress: string
  settlementContract: string
  delegationJson: string
  delegationHash: string
  delegationExpiresAt: number
  approvalMode: 'exact' | 'standing'
  approvalTxHash?: string
  createTxHash?: string
}

export type DelegatedBudgetFlowStep =
  | 'connect_wallet'
  | 'confirm_network'
  | 'derive_smart_account'
  | 'deploy_smart_account'
  | 'fund_smart_account_usdc'
  | 'fund_smart_account_gas'
  | 'approve_settlement_contract'
  | 'create_onchain_budget'
  | 'sign_budget_delegation'
  | 'reset_stale_budget'

export type RevokeDelegatedBudgetWithWalletResult =
  | {
      revocationMode: 'onchain'
      txHash: Hex
      warning?: string
    }
  | {
      revocationMode: 'local_retire'
      warning: string
    }

declare global {
  interface Window {
    ethereum?: {
      request: (args: {
        method: string
        params?: unknown[] | object
      }) => Promise<unknown>
    }
  }
}

function resolveSupportedChain(chainId: number) {
  switch (chainId) {
    case 8453:
      return import('viem/chains').then(({ base }) => base)
    case 84532:
      return import('viem/chains').then(({ baseSepolia }) => baseSepolia)
    default:
      throw new Error(`Unsupported delegated-budget chain ${chainId}.`)
  }
}

function stringifyDelegation(value: unknown) {
  return JSON.stringify(value)
}

function assertNonEmptyHex(value: string, label: string) {
  if (value === '0x') {
    throw new Error(`${label} could not be prepared. Refresh and try again.`)
  }
}

function notifyProgress(
  callback: ((step: DelegatedBudgetFlowStep) => void) | undefined,
  step: DelegatedBudgetFlowStep,
) {
  callback?.(step)
}

function collectErrorText(error: unknown) {
  const parts = new Set<string>()
  let current = error as
    | {
        message?: unknown
        shortMessage?: unknown
        details?: unknown
        cause?: unknown
      }
    | undefined

  while (current && typeof current === 'object') {
    for (const value of [
      current.message,
      current.shortMessage,
      current.details,
    ]) {
      if (typeof value === 'string' && value.trim()) {
        parts.add(value.trim())
      }
    }

    current =
      current.cause && typeof current.cause === 'object'
        ? (current.cause as typeof current)
        : undefined
  }

  return [...parts].join('\n')
}

function formatDelegatedBudgetWalletError(args: {
  step: DelegatedBudgetFlowStep
  error: unknown
}) {
  const fallbackLabels: Record<DelegatedBudgetFlowStep, string> = {
    connect_wallet: 'Connect wallet',
    confirm_network: 'Confirm Base network',
    derive_smart_account: 'Derive smart account',
    deploy_smart_account: 'Deploy smart account',
    fund_smart_account_usdc: 'Fund smart account with USDC',
    fund_smart_account_gas: 'Fund smart account with Base ETH',
    approve_settlement_contract: 'Approve settlement contract',
    create_onchain_budget: 'Create onchain budget',
    sign_budget_delegation: 'Sign budget delegation',
    reset_stale_budget: 'Reset stale budget',
  }
  const message = collectErrorText(args.error) || 'The wallet request failed.'

  if (/^Bundler misconfiguration:/i.test(message)) {
    return new Error(message)
  }

  if (/aa26|over verificationgaslimit/i.test(message)) {
    return new Error(
      'Create onchain budget failed: the bundler rejected this smart-account operation because the verification gas limit was too low. Retry once; BuddyPie now sends a larger verification gas buffer for MetaMask smart-account operations.',
    )
  }

  if (/has no .*ETH on|fund .*base eth/i.test(message)) {
    return new Error(message)
  }

  if (
    /aa21|prefund|insufficientprefunderror|smart account does not have sufficient funds to execute the user operation/i.test(
      message,
    )
  ) {
    return new Error(
      'Need Base gas: fund your MetaMask smart account with a small amount of Base ETH before continuing.',
    )
  }

  if (/insufficient funds|funds for gas|intrinsic gas|gas required/i.test(message)) {
    return new Error(
      'Need Base gas: fund this wallet on Base before continuing.',
    )
  }

  if (
    /user rejected|user denied|rejected the request|request rejected/i.test(
      message,
    )
  ) {
    return new Error(`${fallbackLabels[args.step]} was cancelled in MetaMask.`)
  }

  if (/bundler|user operation/i.test(message)) {
    return new Error(`${fallbackLabels[args.step]} failed: ${message}`)
  }

  return new Error(message)
}

function normalizeUrlForComparison(value: string) {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

function formatBundlerUrlForMessage(value: string) {
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : '(empty)'
}

function getKnownExecutionRpcUrls(chainId: number) {
  switch (chainId) {
    case 8453:
      return ['https://mainnet.base.org']
    case 84532:
      return ['https://sepolia.base.org']
    default:
      return []
  }
}

function isLikelyExecutionRpcUrl(args: {
  chainId: number
  bundlerUrl: string
  chain?: {
    rpcUrls?: {
      default?: {
        http?: readonly string[]
      }
    }
  }
}) {
  const normalizedBundlerUrl = normalizeUrlForComparison(args.bundlerUrl)
  const candidates = new Set<string>([
    ...getKnownExecutionRpcUrls(args.chainId),
    ...(args.chain?.rpcUrls?.default?.http ?? []),
  ])

  return [...candidates].some(
    (candidate) => normalizeUrlForComparison(candidate) === normalizedBundlerUrl,
  )
}

function createBundlerMisconfigurationError(args: {
  chainId: number
  chainName: string
  bundlerUrl: string
  reason?: 'missing' | 'execution_rpc' | 'unsupported_bundler_methods'
}) {
  const exampleBundlerUrl =
    args.chainId === 84532
      ? 'https://api.pimlico.io/v2/84532/rpc?apikey=<YOUR_PIMLICO_API_KEY>'
      : 'https://base-mainnet.infura.io/v3/<YOUR-API-KEY>'
  const displayBundlerUrl = formatBundlerUrlForMessage(args.bundlerUrl)
  const detail =
    args.reason === 'missing'
      ? `is ${displayBundlerUrl}`
      : args.reason === 'execution_rpc'
        ? `${displayBundlerUrl} points to a standard ${args.chainName} RPC endpoint, not an ERC-4337 bundler`
        : `${displayBundlerUrl} does not support the ERC-4337 bundler methods BuddyPie needs on ${args.chainName}`
  const suffix =
    args.reason === 'missing'
      ? ` Configure DELEGATED_BUDGET_BUNDLER_URL to a bundler RPC such as ${exampleBundlerUrl}, then refresh BuddyPie and try again.`
      : ` Configure DELEGATED_BUDGET_BUNDLER_URL to a bundler RPC such as ${exampleBundlerUrl}, then try again.`

  return new Error(
    `Bundler misconfiguration: delegated-budget bundler URL ${detail}.${suffix}`,
  )
}

function normalizeBundlerRpcError(args: {
  chainId: number
  chainName: string
  bundlerUrl: string
  chain?: {
    rpcUrls?: {
      default?: {
        http?: readonly string[]
      }
    }
  }
  error: unknown
}) {
  if (
    isLikelyExecutionRpcUrl({
      chainId: args.chainId,
      bundlerUrl: args.bundlerUrl,
      chain: args.chain,
    })
  ) {
    return createBundlerMisconfigurationError({
      ...args,
      reason: 'execution_rpc',
    })
  }

  const message = collectErrorText(args.error)

  if (
    /rpc method is unsupported|unsupported method|-32601/i.test(message) &&
    /eth_supportedentrypoints|eth_estimateuseroperationgas|user operation|entrypoint/i.test(
      message,
    )
  ) {
    return createBundlerMisconfigurationError({
      ...args,
      reason: 'unsupported_bundler_methods',
    })
  }

  if (/rpc method is unsupported|unsupported method|-32601/i.test(message)) {
    return new Error(
      `Bundler endpoint rejected ERC-4337 methods at ${args.bundlerUrl}. Configure DELEGATED_BUDGET_BUNDLER_URL to a bundler RPC for ${args.chainName}, then try again.`,
    )
  }

  return args.error instanceof Error
    ? args.error
    : new Error(message || 'The bundler request failed.')
}

function isTransientBundlerReceiptError(error: unknown) {
  const message = collectErrorText(error)

  return /failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(
    message,
  )
}

function isUserOperationReceiptTimeoutError(error: unknown) {
  const message = collectErrorText(error)

  return /timed out while waiting for user operation/i.test(message)
}

function isVerificationGasLimitError(error: unknown) {
  const message = collectErrorText(error)

  return /aa26|over verificationgaslimit/i.test(message)
}

function isInvalidSmartAccountNonceError(error: unknown) {
  const message = collectErrorText(error)

  return /aa25|invalid account nonce|invalid smart account nonce/i.test(message)
}

function applyUserOperationGasSafetyMargin(args: {
  callGasLimit: bigint
  verificationGasLimit: bigint
  preVerificationGas: bigint
}) {
  const verificationGasLimit = [
    args.verificationGasLimit * 2n,
    args.verificationGasLimit + 150_000n,
  ].reduce((highest, candidate) =>
    candidate > highest ? candidate : highest,
  )
  const preVerificationGas = [
    args.preVerificationGas + 25_000n,
    (args.preVerificationGas * 12n + 9n) / 10n,
  ].reduce((highest, candidate) =>
    candidate > highest ? candidate : highest,
  )

  return {
    ...args,
    verificationGasLimit,
    preVerificationGas,
  }
}

async function waitForUserOperationReceiptWithRetry(args: {
  bundlerClient: {
    waitForUserOperationReceipt: (args: {
      hash: Hex
      pollingInterval?: number
      retryCount?: number
      timeout?: number
    }) => Promise<{
      success: boolean
      reason?: string
      receipt: {
        status: string
        transactionHash: Hex
      }
    }>
    getUserOperationReceipt?: (args: { hash: Hex }) => Promise<{
      success?: boolean
      reason?: string
      receipt?: {
        status: string
        transactionHash: Hex
      }
      status?: string
      transactionHash?: Hex
    }>
    getUserOperation?: (args: { hash: Hex }) => Promise<{
      transactionHash: Hex
    }>
  }
  userOpHash: Hex
}) {
  const maxAttempts = 3

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await args.bundlerClient.waitForUserOperationReceipt({
        hash: args.userOpHash,
        pollingInterval: 2_000,
        retryCount: 60,
        timeout: 180_000,
      })
    } catch (error) {
      if (isUserOperationReceiptTimeoutError(error)) {
        try {
          const receipt = await args.bundlerClient.getUserOperationReceipt?.({
            hash: args.userOpHash,
          })

          if (receipt?.receipt?.transactionHash) {
            return {
              success: receipt.success ?? receipt.receipt.status === 'success',
              ...(receipt.reason ? { reason: receipt.reason } : {}),
              receipt: receipt.receipt,
            }
          }

          if (receipt?.transactionHash && receipt?.status) {
            return {
              success: receipt.status === 'success',
              receipt: {
                status: receipt.status,
                transactionHash: receipt.transactionHash,
              },
            }
          }
        } catch {}

        try {
          const operation = await args.bundlerClient.getUserOperation?.({
            hash: args.userOpHash,
          })

          if (operation?.transactionHash) {
            throw new Error(
              `The User Operation ${args.userOpHash} was included by the bundler but BuddyPie could not load its receipt yet. Check BaseScan for transaction ${operation.transactionHash}.`,
            )
          }
        } catch (diagnosticError) {
          if (
            diagnosticError instanceof Error &&
            /could not load its receipt yet/i.test(diagnosticError.message)
          ) {
            throw diagnosticError
          }
        }

        throw new Error(
          `The User Operation ${args.userOpHash} never produced a receipt before the timeout. The bundler likely dropped it before inclusion. Retry this step with the latest BuddyPie code.`,
        )
      }

      if (!isTransientBundlerReceiptError(error) || attempt === maxAttempts - 1) {
        throw error
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 1_500 * (attempt + 1))
      })
    }
  }

  throw new Error('Timed out waiting for the smart-account operation receipt.')
}

type BundlerReadySmartAccount = {
  entryPoint: { address: Address }
  getAddress: () => Promise<Address>
  getFactoryArgs: () => Promise<{
    factory?: Address
    factoryData?: Hex
  }>
  getNonce?: () => Promise<bigint>
  getStubSignature: (parameters?: any) => Promise<Hex>
  encodeCalls: (
    calls: readonly { to: Address; data: Hex; value: bigint }[],
  ) => Promise<Hex>
  signUserOperation: (parameters: any) => Promise<Hex>
}

type BundlerReadyPublicClient = {
  estimateFeesPerGas: () => Promise<{
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
    gasPrice?: bigint
  }>
}

async function sendSmartAccountCalls(args: {
  chain: Awaited<ReturnType<typeof resolveSupportedChain>>
  chainId: number
  bundlerUrl: string
  publicClient: BundlerReadyPublicClient
  smartAccount: BundlerReadySmartAccount
  calls: readonly { to: Address; data: Hex; value: bigint }[]
}) {
  if (args.bundlerUrl.trim().length === 0) {
    throw createBundlerMisconfigurationError({
      chainId: args.chainId,
      chainName: args.chain.name,
      bundlerUrl: args.bundlerUrl,
      reason: 'missing',
    })
  }

  const [viem, accountAbstraction] = await Promise.all([
    import('viem'),
    import('viem/account-abstraction'),
  ])

  if (
    isLikelyExecutionRpcUrl({
      chainId: args.chainId,
      bundlerUrl: args.bundlerUrl,
      chain: args.chain,
    })
  ) {
    throw createBundlerMisconfigurationError({
      chainId: args.chainId,
      chainName: args.chain.name,
      bundlerUrl: args.bundlerUrl,
      reason: 'execution_rpc',
    })
  }

  const bundlerClient = accountAbstraction.createBundlerClient({
    chain: args.chain,
    client: args.publicClient as never,
    transport: viem.http(args.bundlerUrl),
    userOperation: {
      estimateFeesPerGas: async () => {
        const fees = await args.publicClient.estimateFeesPerGas()

        if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas) {
          throw new Error('Could not estimate Base gas fees for this wallet operation.')
        }

        return {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      },
    },
  }) as any
  const maxAttempts = 3

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const sender = await args.smartAccount.getAddress()
    const [{ factory, factoryData }, nonce, callData, fees] = await Promise.all([
      args.smartAccount.getFactoryArgs(),
      args.smartAccount.getNonce?.() ?? Promise.resolve(0n),
      args.smartAccount.encodeCalls(args.calls),
      args.publicClient.estimateFeesPerGas(),
    ])

    if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas) {
      throw new Error('Could not estimate Base gas fees for this wallet operation.')
    }

    const baseUserOperation = {
      sender,
      nonce,
      callData,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      ...(factory && factoryData ? { factory, factoryData } : {}),
    }
    const stubSignature =
      await args.smartAccount.getStubSignature(baseUserOperation)
    let gas: {
      callGasLimit: bigint
      verificationGasLimit: bigint
      preVerificationGas: bigint
    }

    try {
      gas = applyUserOperationGasSafetyMargin(
        await bundlerClient.estimateUserOperationGas({
          ...baseUserOperation,
          signature: stubSignature,
          entryPointAddress: args.smartAccount.entryPoint.address,
        }),
      )
    } catch (error) {
      if (isInvalidSmartAccountNonceError(error) && attempt < maxAttempts - 1) {
        continue
      }

      throw normalizeBundlerRpcError({
        chainId: args.chainId,
        chainName: args.chain.name,
        bundlerUrl: args.bundlerUrl,
        chain: args.chain,
        error,
      })
    }

    const signature = await args.smartAccount.signUserOperation({
      ...baseUserOperation,
      ...gas,
      chainId: args.chainId,
    })

    let receipt: {
      success: boolean
      reason?: string
      receipt: {
        status: string
        transactionHash: Hex
      }
    }

    try {
      const userOpHash = await bundlerClient.sendUserOperation({
        ...baseUserOperation,
        ...gas,
        signature,
        entryPointAddress: args.smartAccount.entryPoint.address,
      })
      receipt = await waitForUserOperationReceiptWithRetry({
        bundlerClient,
        userOpHash,
      })
    } catch (error) {
      if (isInvalidSmartAccountNonceError(error) && attempt < maxAttempts - 1) {
        continue
      }

      if (isVerificationGasLimitError(error)) {
        throw new Error(
          'The bundler dropped this MetaMask smart-account operation with AA26 over verificationGasLimit.',
        )
      }

      throw normalizeBundlerRpcError({
        chainId: args.chainId,
        chainName: args.chain.name,
        bundlerUrl: args.bundlerUrl,
        chain: args.chain,
        error,
      })
    }

    if (!receipt.success || receipt.receipt.status !== 'success') {
      throw new Error(
        receipt.reason ||
          'The smart-account wallet operation reverted onchain.',
      )
    }

    return receipt.receipt.transactionHash
  }

  throw new Error(
    'The smart-account wallet operation could not be sent with a fresh nonce after multiple attempts.',
  )
}

async function ensureDelegatedBudgetContractAllowance(args: {
  publicClient: {
    readContract: (args: any) => Promise<any>
    estimateFeesPerGas: BundlerReadyPublicClient['estimateFeesPerGas']
  }
  smartAccount: BundlerReadySmartAccount
  smartAccountAddress: Address
  chain: Awaited<ReturnType<typeof resolveSupportedChain>>
  chainId: number
  bundlerUrl: string
  tokenAddress: Address
  settlementContract: Address
  amountUsdCents: number
  budgetType: DelegatedBudgetType
}) {
  const requiredAllowance = getDelegatedBudgetApprovalAmount({
    amountUsdCents: args.amountUsdCents,
    budgetType: args.budgetType,
  })
  const currentAllowance = await args.publicClient.readContract({
    address: getAddress(args.tokenAddress),
    abi: erc20ApprovalAbi,
    functionName: 'allowance',
    args: [
      getAddress(args.smartAccountAddress),
      getAddress(args.settlementContract),
    ],
  })

  if (currentAllowance >= requiredAllowance) {
    return null
  }

  return await sendSmartAccountCalls({
    chain: args.chain,
    chainId: args.chainId,
    bundlerUrl: args.bundlerUrl,
    publicClient: args.publicClient,
    smartAccount: args.smartAccount,
    calls: [
      {
        to: getAddress(args.tokenAddress),
        data: encodeFunctionData({
          abi: erc20ApprovalAbi,
          functionName: 'approve',
          args: [getAddress(args.settlementContract), requiredAllowance],
        }),
        value: 0n,
      },
    ],
  })
}

type OnchainDelegatedBudget = {
  budgetType: DelegatedBudgetType
  interval: DelegatedBudgetInterval | null
  configuredAmountUsdCents: number
  remainingAmountUsdCents: number
  periodStartedAt: number | null
  periodEndsAt: number | null
}

async function readOnchainDelegatedBudget(args: {
  publicClient: {
    readContract: (args: {
      address: Address
      abi: typeof delegatedBudgetContractAbi
      functionName: 'getBudget'
      args: [Hex]
    }) => Promise<{
      owner: Address
      delegate: Address
      delegatorSmartAccount: Address
      token: Address
      configuredAmount: bigint
      remainingAmount: bigint
      periodStartAt: bigint
      periodEndsAt: bigint
      budgetType: number
      interval: number
      active: boolean
      revoked: boolean
    }>
  }
  settlementContract: Address
  contractBudgetId: Hex
}) {
  const budget = await args.publicClient.readContract({
    address: getAddress(args.settlementContract),
    abi: delegatedBudgetContractAbi,
    functionName: 'getBudget',
    args: [args.contractBudgetId],
  })

  if (!budget.active || budget.revoked) {
    throw new Error('The delegated budget was created but is not active onchain.')
  }

  const budgetType = contractEnumToDelegatedBudgetType(Number(budget.budgetType))
  const interval = contractEnumToDelegatedBudgetInterval(Number(budget.interval))

  return {
    budgetType,
    interval,
    configuredAmountUsdCents: Number(budget.configuredAmount / 10_000n),
    remainingAmountUsdCents: Number(budget.remainingAmount / 10_000n),
    periodStartedAt:
      budget.periodStartAt > 0n ? Number(budget.periodStartAt) * 1000 : null,
    periodEndsAt:
      budget.periodEndsAt > 0n ? Number(budget.periodEndsAt) * 1000 : null,
  } satisfies OnchainDelegatedBudget
}

async function assertDeployedSmartAccount(args: {
  publicClient: {
    getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>
  }
  address: Address
}) {
  const code = await args.publicClient.getCode({
    address: getAddress(args.address),
  })

  if (!code || code === '0x') {
    throw new Error(
      'Your MetaMask smart account is not deployed yet. Deploy or activate it onchain before creating a delegated budget.',
    )
  }
}

export async function assertSufficientSmartAccountUsdcBalance(args: {
  publicClient: {
    readContract: (args: {
      address: Address
      abi: typeof erc20BalanceAbi
      functionName: 'balanceOf'
      args: [Address]
    }) => Promise<bigint>
  }
  tokenAddress: Address
  smartAccountAddress: Address
  requiredAmountUsdCents: number
  chainName: string
  actionLabel: string
  waitForFundingMs?: number
  pollIntervalMs?: number
}) {
  const requiredAmountAtomic = usdCentsToUsdcAtomic(args.requiredAmountUsdCents)
  const deadline =
    typeof args.waitForFundingMs === 'number' && args.waitForFundingMs > 0
      ? Date.now() + args.waitForFundingMs
      : null
  const pollIntervalMs =
    typeof args.pollIntervalMs === 'number' && args.pollIntervalMs > 0
      ? args.pollIntervalMs
      : 750
  let balanceAtomic = 0n

  do {
    balanceAtomic = await args.publicClient.readContract({
      address: getAddress(args.tokenAddress),
      abi: erc20BalanceAbi,
      functionName: 'balanceOf',
      args: [getAddress(args.smartAccountAddress)],
    })

    if (balanceAtomic >= requiredAmountAtomic) {
      return balanceAtomic
    }

    if (deadline === null || Date.now() >= deadline) {
      break
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs)
    })
  } while (true)

  if (balanceAtomic < requiredAmountAtomic) {
    const balanceUsdCents = Number(balanceAtomic / 10_000n)
    throw new Error(
      `Your MetaMask smart account only has ${formatUsdCents(balanceUsdCents)} USDC on ${args.chainName}. Fund ${getAddress(args.smartAccountAddress)} before ${args.actionLabel} (${formatUsdCents(args.requiredAmountUsdCents)} required).`,
    )
  }

  return balanceAtomic
}

export async function assertSufficientSmartAccountNativeBalance(args: {
  publicClient: {
    getBalance: (args: { address: Address }) => Promise<bigint>
  }
  smartAccountAddress: Address
  chainName: string
  actionLabel: string
}) {
  const balance = await args.publicClient.getBalance({
    address: getAddress(args.smartAccountAddress),
  })

  if (balance <= 0n) {
    throw new Error(
      `Your MetaMask smart account has no Base ETH on ${args.chainName}. Fund ${getAddress(args.smartAccountAddress)} with a small amount of Base ETH before ${args.actionLabel}.`,
    )
  }

  return balance
}

const MIN_SMART_ACCOUNT_GAS_TOP_UP_WEI = 200_000_000_000_000n

async function assertSufficientWalletUsdcBalance(args: {
  publicClient: {
    readContract: (args: {
      address: Address
      abi: typeof erc20BalanceAbi
      functionName: 'balanceOf'
      args: [Address]
    }) => Promise<bigint>
  }
  tokenAddress: Address
  walletAddress: Address
  requiredAmountAtomic: bigint
  chainName: string
}) {
  const balanceAtomic = await args.publicClient.readContract({
    address: getAddress(args.tokenAddress),
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [getAddress(args.walletAddress)],
  })

  if (balanceAtomic < args.requiredAmountAtomic) {
    const balanceUsdCents = Number(balanceAtomic / 10_000n)
    const requiredUsdCents = Number(args.requiredAmountAtomic / 10_000n)
    throw new Error(
      `Your connected wallet only has ${formatUsdCents(balanceUsdCents)} USDC on ${args.chainName}. Add funds before BuddyPie can top up your MetaMask smart account (${formatUsdCents(requiredUsdCents)} required).`,
    )
  }
}

async function assertSufficientWalletNativeBalance(args: {
  publicClient: {
    getBalance: (args: { address: Address }) => Promise<bigint>
  }
  walletAddress: Address
  requiredAmountWei: bigint
  chainName: string
}) {
  const balance = await args.publicClient.getBalance({
    address: getAddress(args.walletAddress),
  })

  if (balance < args.requiredAmountWei) {
    throw new Error(
      `Your connected wallet does not have enough Base ETH on ${args.chainName} to fund the MetaMask smart account for gas.`,
    )
  }
}

export async function topUpSmartAccountUsdcIfNeeded(args: {
  publicClient: {
    readContract: (args: {
      address: Address
      abi: typeof erc20BalanceAbi
      functionName: 'balanceOf'
      args: [Address]
    }) => Promise<bigint>
    waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{
      status: string
    }>
  }
  walletClient: {
    sendTransaction: (args: {
      account: Address
      to: Address
      data: Hex
      value?: bigint
    }) => Promise<Hex>
  }
  tokenAddress: Address
  walletAddress: Address
  smartAccountAddress: Address
  requiredAmountUsdCents: number
  chainName: string
  waitForIncomingFundingMs?: number
  pollIntervalMs?: number
}) {
  try {
    await assertSufficientSmartAccountUsdcBalance({
      publicClient: args.publicClient,
      tokenAddress: args.tokenAddress,
      smartAccountAddress: args.smartAccountAddress,
      requiredAmountUsdCents: args.requiredAmountUsdCents,
      chainName: args.chainName,
      actionLabel: 'creating this delegated budget',
      waitForFundingMs: args.waitForIncomingFundingMs ?? 10_000,
      pollIntervalMs: args.pollIntervalMs,
    })
    return null
  } catch {
    // Fall through to EOA-funded top up if the smart account is still short.
  }

  const requiredAmountAtomic = usdCentsToUsdcAtomic(args.requiredAmountUsdCents)
  const smartAccountBalanceAtomic = await args.publicClient.readContract({
    address: getAddress(args.tokenAddress),
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [getAddress(args.smartAccountAddress)],
  })
  const missingAmountAtomic = requiredAmountAtomic - smartAccountBalanceAtomic
  await assertSufficientWalletUsdcBalance({
    publicClient: args.publicClient,
    tokenAddress: args.tokenAddress,
    walletAddress: args.walletAddress,
    requiredAmountAtomic: missingAmountAtomic,
    chainName: args.chainName,
  })

  const txHash = await args.walletClient.sendTransaction({
    account: getAddress(args.walletAddress),
    to: getAddress(args.tokenAddress),
    data: encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: 'transfer',
      args: [getAddress(args.smartAccountAddress), missingAmountAtomic],
    }),
    value: 0n,
  })
  const receipt = await args.publicClient.waitForTransactionReceipt({
    hash: txHash,
  })

  if (receipt.status !== 'success') {
    throw new Error(
      'The USDC top-up transaction to your MetaMask smart account reverted.',
    )
  }

  await assertSufficientSmartAccountUsdcBalance({
    publicClient: args.publicClient,
    tokenAddress: args.tokenAddress,
    smartAccountAddress: args.smartAccountAddress,
    requiredAmountUsdCents: args.requiredAmountUsdCents,
    chainName: args.chainName,
    actionLabel: 'creating this delegated budget',
    waitForFundingMs: 15_000,
    pollIntervalMs: args.pollIntervalMs,
  })

  return txHash
}

export async function topUpSmartAccountGasIfNeeded(args: {
  publicClient: {
    getBalance: (args: { address: Address }) => Promise<bigint>
    waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{
      status: string
    }>
  }
  walletClient: {
    sendTransaction: (args: {
      account: Address
      to: Address
      data?: Hex
      value?: bigint
    }) => Promise<Hex>
  }
  walletAddress: Address
  smartAccountAddress: Address
  chainName: string
}) {
  const smartAccountBalance = await args.publicClient.getBalance({
    address: getAddress(args.smartAccountAddress),
  })

  if (smartAccountBalance > 0n) {
    return null
  }

  await assertSufficientWalletNativeBalance({
    publicClient: args.publicClient,
    walletAddress: args.walletAddress,
    requiredAmountWei: MIN_SMART_ACCOUNT_GAS_TOP_UP_WEI,
    chainName: args.chainName,
  })

  const txHash = await args.walletClient.sendTransaction({
    account: getAddress(args.walletAddress),
    to: getAddress(args.smartAccountAddress),
    data: '0x',
    value: MIN_SMART_ACCOUNT_GAS_TOP_UP_WEI,
  })
  const receipt = await args.publicClient.waitForTransactionReceipt({
    hash: txHash,
  })

  if (receipt.status !== 'success') {
    throw new Error(
      'The Base ETH top-up transaction to your MetaMask smart account reverted.',
    )
  }

  return txHash
}

export async function deployMetaMaskSmartAccountIfNeeded(args: {
  publicClient: {
    getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>
    waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{
      status: string
    }>
  }
  walletClient: {
    sendTransaction: (args: {
      account: Address
      to: Address
      data: Hex
      value?: bigint
    }) => Promise<Hex>
  }
  smartAccount: {
    getFactoryArgs: () => Promise<{
      factory?: Address
      factoryData?: Hex
    }>
  }
  ownerAddress: Address
  address: Address
}) {
  const normalizedAddress = getAddress(args.address)
  const existingCode = await args.publicClient.getCode({
    address: normalizedAddress,
  })

  if (existingCode && existingCode !== '0x') {
    return null
  }

  const { factory, factoryData } = await args.smartAccount.getFactoryArgs()

  if (!factory || !factoryData || factoryData === '0x') {
    throw new Error(
      'MetaMask could not prepare the smart-account deployment transaction. Refresh and try again.',
    )
  }

  const txHash = await args.walletClient.sendTransaction({
    account: getAddress(args.ownerAddress),
    to: getAddress(factory),
    data: factoryData,
    value: 0n,
  })
  const receipt = await args.publicClient.waitForTransactionReceipt({
    hash: txHash,
  })

  if (receipt.status !== 'success') {
    throw new Error(
      'The MetaMask smart-account deployment transaction reverted. Ensure your wallet has gas and try again.',
    )
  }

  await assertDeployedSmartAccount({
    publicClient: args.publicClient,
    address: normalizedAddress,
  })

  return txHash
}

export function buildDelegatedBudgetCaveats(args: {
  backendDelegateAddress: Address
  nowSeconds: number
  delegationExpiresAtSeconds: number
}) {
  return [
    // Budget amount and period limits are enforced by BuddyPie's settlement
    // contract. ERC20 transfer caveats only understand direct token-transfer
    // executions, so they break this settlement-contract flow.
    {
      type: 'redeemer' as const,
      redeemers: [args.backendDelegateAddress],
    },
    {
      type: 'timestamp' as const,
      afterThreshold: Math.max(args.nowSeconds - 60, 1),
      beforeThreshold: args.delegationExpiresAtSeconds,
    },
    {
      type: 'valueLte' as const,
      maxValue: 0n,
    },
  ]
}

export async function sendCreateDelegatedBudgetUserOperation(args: {
  chain: Awaited<ReturnType<typeof resolveSupportedChain>>
  chainId: number
  bundlerUrl: string
  publicClient: BundlerReadyPublicClient
  smartAccount: BundlerReadySmartAccount
  settlementContract: Address
  contractBudgetId: Hex
  delegatorSmartAccount: Address
  backendDelegateAddress: Address
  budgetType: DelegatedBudgetType
  interval?: DelegatedBudgetInterval | null
  amountUsdCents: number
}) {
  return await sendSmartAccountCalls({
    chain: args.chain,
    chainId: args.chainId,
    bundlerUrl: args.bundlerUrl,
    publicClient: args.publicClient,
    smartAccount: args.smartAccount,
    calls: [
      {
        to: getAddress(args.settlementContract),
        data: encodeFunctionData({
          abi: delegatedBudgetContractAbi,
          functionName: 'createBudget',
          args: [
            args.contractBudgetId,
            getAddress(args.delegatorSmartAccount),
            getAddress(args.backendDelegateAddress),
            delegatedBudgetTypeToContractEnum(args.budgetType),
            delegatedBudgetIntervalToContractEnum(args.interval),
            usdCentsToUsdcAtomic(args.amountUsdCents),
          ],
        }),
        value: 0n,
      },
    ],
  })
}

export async function createDelegatedBudgetWithWallet(
  args: DelegatedBudgetSetupArgs & {
    onProgress?: (step: DelegatedBudgetFlowStep) => void
  },
): Promise<DelegatedBudgetSetupResult> {
  const ethereum = window.ethereum
  let currentStep: DelegatedBudgetFlowStep = 'connect_wallet'

  if (!ethereum) {
    throw new Error('Install MetaMask before setting up a delegated budget.')
  }

  try {
    const chain = await resolveSupportedChain(args.chainId)
    const [viem, toolkit] = await Promise.all([
      import('viem'),
      import('@metamask/delegation-toolkit'),
    ])
    const transport = viem.custom(ethereum as never)
    const walletClientWithoutAccount = viem.createWalletClient({
      chain,
      transport,
    })
    currentStep = 'confirm_network'
    notifyProgress(args.onProgress, currentStep)
    const currentChainId = await walletClientWithoutAccount.getChainId()

    if (currentChainId !== args.chainId) {
      try {
        await walletClientWithoutAccount.switchChain({ id: args.chainId })
      } catch {
        throw new Error(`Switch MetaMask to ${chain.name} before continuing.`)
      }
    }

    currentStep = 'connect_wallet'
    notifyProgress(args.onProgress, currentStep)
    const [ownerAddress] = await walletClientWithoutAccount.requestAddresses()

    if (!ownerAddress) {
      throw new Error('Connect MetaMask before setting up a delegated budget.')
    }

    const normalizedOwnerAddress = viem.getAddress(ownerAddress)
    const walletClient = viem.createWalletClient({
      account: normalizedOwnerAddress,
      chain,
      transport,
    })
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(chain.rpcUrls.default.http[0]),
    })
    currentStep = 'derive_smart_account'
    notifyProgress(args.onProgress, currentStep)
    const smartAccount = await toolkit.toMetaMaskSmartAccount({
      client: publicClient as never,
      implementation: toolkit.Implementation.Hybrid,
      deployParams: [normalizedOwnerAddress, [], [], []],
      deploySalt: '0x',
      signer: { walletClient: walletClient as never },
    })
    const delegatorSmartAccount = viem.getAddress(smartAccount.address)
    currentStep = 'deploy_smart_account'
    notifyProgress(args.onProgress, currentStep)
    await deployMetaMaskSmartAccountIfNeeded({
      publicClient,
      walletClient,
      smartAccount,
      ownerAddress: normalizedOwnerAddress,
      address: delegatorSmartAccount,
    })
    await assertDeployedSmartAccount({
      publicClient,
      address: delegatorSmartAccount,
    })
    const backendDelegateAddress = viem.getAddress(
      args.backendDelegateAddress as Address,
    )
    const settlementContract = viem.getAddress(
      args.settlementContract as Address,
    )
    const tokenAddress = viem.getAddress(args.tokenAddress as Address)
    const treasuryAddress = viem.getAddress(args.treasuryAddress as Address)
    const nowSeconds = Math.floor(Date.now() / 1000)
    const delegationExpiresAt = (nowSeconds + 365 * 24 * 60 * 60) * 1000
    const contractBudgetId = buildDelegatedBudgetId(
      `buddypie:${normalizedOwnerAddress}:${delegatorSmartAccount}:${crypto.randomUUID()}`,
    )
    assertNonEmptyHex(contractBudgetId, 'Delegated-budget salt')
    currentStep = 'fund_smart_account_usdc'
    notifyProgress(args.onProgress, currentStep)
    await topUpSmartAccountUsdcIfNeeded({
      publicClient,
      walletClient,
      tokenAddress,
      walletAddress: normalizedOwnerAddress,
      smartAccountAddress: delegatorSmartAccount,
      requiredAmountUsdCents: args.amountUsdCents,
      chainName: chain.name,
    })
    await assertSufficientSmartAccountUsdcBalance({
      publicClient,
      tokenAddress,
      smartAccountAddress: delegatorSmartAccount,
      requiredAmountUsdCents: args.amountUsdCents,
      chainName: chain.name,
      actionLabel: 'creating this delegated budget',
      waitForFundingMs: 15_000,
    })
    currentStep = 'fund_smart_account_gas'
    notifyProgress(args.onProgress, currentStep)
    await topUpSmartAccountGasIfNeeded({
      publicClient,
      walletClient,
      walletAddress: normalizedOwnerAddress,
      smartAccountAddress: delegatorSmartAccount,
      chainName: chain.name,
    })
    await assertSufficientSmartAccountNativeBalance({
      publicClient,
      smartAccountAddress: delegatorSmartAccount,
      chainName: chain.name,
      actionLabel: 'creating this delegated budget',
    })
    const unsignedDelegation = createDelegation({
      environment: toolkit.getDeleGatorEnvironment(args.chainId),
      scope: {
        type: 'functionCall',
        targets: [settlementContract],
        selectors: ['settleBudget(bytes32,bytes32,uint256)'],
        allowedCalldata: [
          {
            startIndex: 4,
            value: contractBudgetId,
          },
        ],
      },
      from: delegatorSmartAccount,
      to: backendDelegateAddress,
      caveats: buildDelegatedBudgetCaveats({
        backendDelegateAddress,
        nowSeconds,
        delegationExpiresAtSeconds: Math.floor(delegationExpiresAt / 1000),
      }),
      salt: contractBudgetId,
    })
    assertNonEmptyHex(unsignedDelegation.salt, 'Delegation salt')
    currentStep = 'sign_budget_delegation'
    notifyProgress(args.onProgress, currentStep)
    const signature = await smartAccount.signDelegation({
      delegation: unsignedDelegation,
      chainId: args.chainId,
    })
    const signedDelegation = {
      ...unsignedDelegation,
      signature,
    }
    currentStep = 'approve_settlement_contract'
    notifyProgress(args.onProgress, currentStep)
    const approvalTxHash = await ensureDelegatedBudgetContractAllowance({
      publicClient,
      smartAccount,
      smartAccountAddress: delegatorSmartAccount,
      chain,
      chainId: args.chainId,
      bundlerUrl: args.bundlerUrl,
      tokenAddress,
      settlementContract,
      amountUsdCents: args.amountUsdCents,
      budgetType: args.budgetType,
    })
    currentStep = 'create_onchain_budget'
    notifyProgress(args.onProgress, currentStep)
    const createBudgetTxHash = await sendCreateDelegatedBudgetUserOperation({
      chain,
      chainId: args.chainId,
      bundlerUrl: args.bundlerUrl,
      publicClient,
      smartAccount,
      settlementContract,
      contractBudgetId,
      delegatorSmartAccount,
      backendDelegateAddress,
      budgetType: args.budgetType,
      interval: args.interval,
      amountUsdCents: args.amountUsdCents,
    })
    const onchainBudget = await readOnchainDelegatedBudget({
      publicClient,
      settlementContract,
      contractBudgetId,
    })

    return {
      contractBudgetId,
      budgetType: onchainBudget.budgetType,
      ...(onchainBudget.budgetType === 'periodic'
        ? { interval: onchainBudget.interval }
        : {}),
      configuredAmountUsdCents: onchainBudget.configuredAmountUsdCents,
      remainingAmountUsdCents: onchainBudget.remainingAmountUsdCents,
      periodStartedAt: onchainBudget.periodStartedAt,
      periodEndsAt: onchainBudget.periodEndsAt,
      ownerAddress: normalizedOwnerAddress,
      delegatorSmartAccount,
      delegateAddress: backendDelegateAddress,
      treasuryAddress,
      settlementContract,
      delegationJson: stringifyDelegation(signedDelegation),
      delegationHash: hashDelegation(signedDelegation as never),
      delegationExpiresAt,
      approvalMode: args.budgetType === 'periodic' ? 'standing' : 'exact',
      ...(approvalTxHash ? { approvalTxHash } : {}),
      createTxHash: createBudgetTxHash,
    }
  } catch (error) {
    throw formatDelegatedBudgetWalletError({
      step: currentStep,
      error,
    })
  }
}

export async function sendRevokeDelegatedBudgetUserOperation(args: {
  chain: Awaited<ReturnType<typeof resolveSupportedChain>>
  chainId: number
  bundlerUrl: string
  publicClient: BundlerReadyPublicClient
  smartAccount: BundlerReadySmartAccount
  delegation: unknown
  settlementContract: Address
  contractBudgetId: Hex
}) {
  const toolkit = await import('@metamask/delegation-toolkit')
  const environment = toolkit.getDeleGatorEnvironment(args.chainId)
  const disableDelegationCallData =
    toolkit.contracts.DelegationManager.encode.disableDelegation({
      delegation: args.delegation as never,
    })

  return await sendSmartAccountCalls({
    chain: args.chain,
    chainId: args.chainId,
    bundlerUrl: args.bundlerUrl,
    publicClient: args.publicClient,
    smartAccount: args.smartAccount,
    calls: [
      {
        to: environment.DelegationManager as Address,
        data: disableDelegationCallData,
        value: 0n,
      },
      {
        to: getAddress(args.settlementContract),
        data: encodeFunctionData({
          abi: delegatedBudgetContractAbi,
          functionName: 'revokeBudget',
          args: [args.contractBudgetId],
        }),
        value: 0n,
      },
    ],
  })
}

export async function revokeDelegatedBudgetWithWallet(args: {
  chainId: number
  bundlerUrl: string
  settlementContract: string
  contractBudgetId: string
  delegationJson: string
  onProgress?: (step: DelegatedBudgetFlowStep) => void
}): Promise<RevokeDelegatedBudgetWithWalletResult> {
  const ethereum = window.ethereum
  let currentStep: DelegatedBudgetFlowStep = 'connect_wallet'

  if (!ethereum) {
    throw new Error('Install MetaMask before revoking a delegated budget.')
  }

  try {
    const chain = await resolveSupportedChain(args.chainId)
    const [viem, toolkit] = await Promise.all([
      import('viem'),
      import('@metamask/delegation-toolkit'),
    ])
    const transport = viem.custom(ethereum as never)
    const walletClientWithoutAccount = viem.createWalletClient({
      chain,
      transport,
    })
    currentStep = 'confirm_network'
    notifyProgress(args.onProgress, currentStep)
    const currentChainId = await walletClientWithoutAccount.getChainId()

    if (currentChainId !== args.chainId) {
      try {
        await walletClientWithoutAccount.switchChain({ id: args.chainId })
      } catch {
        throw new Error(`Switch MetaMask to ${chain.name} before continuing.`)
      }
    }

    currentStep = 'connect_wallet'
    notifyProgress(args.onProgress, currentStep)
    const [ownerAddress] = await walletClientWithoutAccount.requestAddresses()

    if (!ownerAddress) {
      throw new Error('Connect MetaMask before revoking a delegated budget.')
    }

    const normalizedOwnerAddress = viem.getAddress(ownerAddress)
    const walletClient = viem.createWalletClient({
      account: normalizedOwnerAddress,
      chain,
      transport,
    })
    const publicClient = viem.createPublicClient({
      chain,
      transport: viem.http(chain.rpcUrls.default.http[0]),
    })
    const delegation = JSON.parse(args.delegationJson) as Parameters<
      typeof toolkit.contracts.DelegationManager.execute.disableDelegation
    >[0]['delegation']
    const delegatedSmartAccountAddress = viem.getAddress(
      delegation.delegator as Address,
    )
    currentStep = 'derive_smart_account'
    notifyProgress(args.onProgress, currentStep)
    const smartAccount = await toolkit.toMetaMaskSmartAccount({
      client: publicClient as never,
      implementation: toolkit.Implementation.Hybrid,
      deployParams: [normalizedOwnerAddress, [], [], []],
      deploySalt: '0x',
      signer: { walletClient: walletClient as never },
    })
    const derivedSmartAccountAddress = viem.getAddress(smartAccount.address)

    if (derivedSmartAccountAddress !== delegatedSmartAccountAddress) {
      const deployedCode = await publicClient.getCode({
        address: delegatedSmartAccountAddress,
      })

      if (!deployedCode || deployedCode === '0x') {
        return {
          revocationMode: 'local_retire',
          warning:
            'BuddyPie retired this stale delegated budget locally because the original MetaMask smart account was never deployed onchain. Connect the original wallet later if you still want to revoke it onchain.',
        }
      }

      throw new Error(
        'Connect the wallet that originally created this delegated budget before revoking it.',
      )
    }

    currentStep = 'deploy_smart_account'
    notifyProgress(args.onProgress, currentStep)
    await deployMetaMaskSmartAccountIfNeeded({
      publicClient,
      walletClient,
      smartAccount,
      ownerAddress: normalizedOwnerAddress,
      address: delegatedSmartAccountAddress,
    })
    await assertDeployedSmartAccount({
      publicClient,
      address: delegatedSmartAccountAddress,
    })
    await assertSufficientSmartAccountNativeBalance({
      publicClient,
      smartAccountAddress: delegatedSmartAccountAddress,
      chainName: chain.name,
      actionLabel: 'resetting this delegated budget',
    })

    currentStep = 'reset_stale_budget'
    notifyProgress(args.onProgress, currentStep)
    const txHash = await sendRevokeDelegatedBudgetUserOperation({
      chain,
      chainId: args.chainId,
      bundlerUrl: args.bundlerUrl,
      publicClient,
      smartAccount,
      delegation,
      settlementContract: viem.getAddress(args.settlementContract as Address),
      contractBudgetId: args.contractBudgetId as Hex,
    })

    return {
      revocationMode: 'onchain',
      txHash,
    }
  } catch (error) {
    throw formatDelegatedBudgetWalletError({
      step: currentStep,
      error,
    })
  }
}
