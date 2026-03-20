import { createCaveat, createDelegation, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { createTimestampTerms, hashDelegation } from '@metamask/delegation-core'
import type { Address, Hex } from 'viem'
import {
  concat,
  getAddress,
  pad,
  toFunctionSelector,
  toHex,
} from 'viem'
import {
  erc20BalanceAbi,
  advanceDelegatedBudgetPeriodEndMs,
  buildDelegatedBudgetId,
  delegatedBudgetIntervalToDurationSeconds,
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
    sign_budget_delegation: 'Sign budget delegation',
    reset_stale_budget: 'Reset stale budget',
  }
  const message = collectErrorText(args.error) || 'The wallet request failed.'

  if (/^Bundler misconfiguration:/i.test(message)) {
    return new Error(message)
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
      ? 'https://public.pimlico.io/v2/84532/rpc'
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
}) {
  const requiredAmountAtomic = usdCentsToUsdcAtomic(args.requiredAmountUsdCents)
  const balanceAtomic = await args.publicClient.readContract({
    address: getAddress(args.tokenAddress),
    abi: erc20BalanceAbi,
    functionName: 'balanceOf',
    args: [getAddress(args.smartAccountAddress)],
  })

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

function buildExecutionRestrictions(args: {
  environment: ReturnType<typeof getDeleGatorEnvironment>
  tokenAddress: Address
  treasuryAddress: Address
  backendDelegateAddress: Address
  delegationExpiresAtSeconds: number
}) {
  const transferSelector = toFunctionSelector('transfer(address,uint256)')
  const transferRecipient = pad(args.treasuryAddress, {
    size: 32,
  })

  return [
    createCaveat(
      args.environment.caveatEnforcers.AllowedTargetsEnforcer as Address,
      concat([args.tokenAddress]),
      '0x',
    ),
    createCaveat(
      args.environment.caveatEnforcers.AllowedMethodsEnforcer as Address,
      concat([transferSelector]),
      '0x',
    ),
    createCaveat(
      args.environment.caveatEnforcers.AllowedCalldataEnforcer as Address,
      concat([toHex(4, { size: 32 }), transferRecipient]),
      '0x',
    ),
    createCaveat(
      args.environment.caveatEnforcers.RedeemerEnforcer as Address,
      concat([args.backendDelegateAddress]),
      '0x',
    ),
    createCaveat(
      args.environment.caveatEnforcers.TimestampEnforcer as Address,
      createTimestampTerms({
        timestampAfterThreshold: Math.max(
          Math.floor(Date.now() / 1000) - 60,
          1,
        ),
        timestampBeforeThreshold: args.delegationExpiresAtSeconds,
      }),
      '0x',
    ),
  ]
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
    const createTxHash = await deployMetaMaskSmartAccountIfNeeded({
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
    const tokenAddress = viem.getAddress(args.tokenAddress as Address)
    const treasuryAddress = viem.getAddress(args.treasuryAddress as Address)
    const environment = toolkit.getDeleGatorEnvironment(args.chainId)
    const nowSeconds = Math.floor(Date.now() / 1000)
    const delegationExpiresAt = (nowSeconds + 365 * 24 * 60 * 60) * 1000
    const contractBudgetId = buildDelegatedBudgetId(
      `buddypie:${normalizedOwnerAddress}:${delegatorSmartAccount}:${crypto.randomUUID()}`,
    )
    assertNonEmptyHex(contractBudgetId, 'Delegated-budget salt')
    await assertSufficientSmartAccountUsdcBalance({
      publicClient,
      tokenAddress,
      smartAccountAddress: delegatorSmartAccount,
      requiredAmountUsdCents: args.amountUsdCents,
      chainName: chain.name,
      actionLabel: 'creating this delegated budget',
    })

    const extraCaveats = buildExecutionRestrictions({
      environment,
      tokenAddress,
      treasuryAddress,
      backendDelegateAddress,
      delegationExpiresAtSeconds: Math.floor(delegationExpiresAt / 1000),
    })
    const unsignedDelegation = createDelegation({
      environment,
      scope:
        args.budgetType === 'periodic'
          ? {
              type: 'erc20PeriodTransfer',
              tokenAddress,
              periodAmount: usdCentsToUsdcAtomic(args.amountUsdCents),
              periodDuration: delegatedBudgetIntervalToDurationSeconds(
                args.interval ?? 'month',
              ),
              startDate: nowSeconds,
            }
          : {
              type: 'erc20TransferAmount',
              tokenAddress,
              maxAmount: usdCentsToUsdcAtomic(args.amountUsdCents),
            },
      from: delegatorSmartAccount,
      to: backendDelegateAddress,
      caveats: extraCaveats,
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
    const periodStartedAt =
      args.budgetType === 'periodic' ? nowSeconds * 1000 : null
    const periodEndsAt =
      args.budgetType === 'periodic' && periodStartedAt
        ? advanceDelegatedBudgetPeriodEndMs(
            periodStartedAt,
            args.interval ?? 'month',
          )
        : null

    return {
      contractBudgetId,
      budgetType: args.budgetType,
      ...(args.budgetType === 'periodic'
        ? { interval: args.interval ?? null }
        : {}),
      configuredAmountUsdCents: args.amountUsdCents,
      remainingAmountUsdCents: args.amountUsdCents,
      periodStartedAt,
      periodEndsAt,
      ownerAddress: normalizedOwnerAddress,
      delegatorSmartAccount,
      delegateAddress: backendDelegateAddress,
      treasuryAddress,
      delegationJson: stringifyDelegation(signedDelegation),
      delegationHash: hashDelegation(signedDelegation as never),
      delegationExpiresAt,
      approvalMode: args.budgetType === 'periodic' ? 'standing' : 'exact',
      ...(createTxHash ? { createTxHash } : {}),
    }
  } catch (error) {
    throw formatDelegatedBudgetWalletError({
      step: currentStep,
      error,
    })
  }
}

export async function sendDisableDelegationUserOperation(args: {
  chain: Awaited<ReturnType<typeof resolveSupportedChain>>
  chainId: number
  bundlerUrl: string
  publicClient: {
    estimateFeesPerGas: () => Promise<{
      maxFeePerGas?: bigint
      maxPriorityFeePerGas?: bigint
      gasPrice?: bigint
    }>
  }
  smartAccount: unknown
  delegation: unknown
}) {
  if (args.bundlerUrl.trim().length === 0) {
    throw createBundlerMisconfigurationError({
      chainId: args.chainId,
      chainName: args.chain.name,
      bundlerUrl: args.bundlerUrl,
      reason: 'missing',
    })
  }

  const [viem, toolkit, accountAbstraction] = await Promise.all([
    import('viem'),
    import('@metamask/delegation-toolkit'),
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
  const environment = toolkit.getDeleGatorEnvironment(args.chainId)
  const disableDelegationCallData =
    toolkit.contracts.DelegationManager.encode.disableDelegation({
      delegation: args.delegation as never,
    })
  const bundlerSmartAccount = args.smartAccount as {
    entryPoint: { address: Address }
    getAddress: () => Promise<Address>
    getFactoryArgs: () => Promise<{
      factory?: Address
      factoryData?: Hex
    }>
    getNonce?: () => Promise<bigint>
    getStubSignature: (parameters?: Record<string, unknown>) => Promise<Hex>
    encodeCalls: (
      calls: readonly { to: Address; data: Hex; value: bigint }[],
    ) => Promise<Hex>
    signUserOperation: (parameters: Record<string, unknown>) => Promise<Hex>
  }
  const bundlerClient = accountAbstraction.createBundlerClient({
    chain: args.chain,
    client: args.publicClient as never,
    transport: viem.http(args.bundlerUrl),
    userOperation: {
      estimateFeesPerGas: async () => {
        const fees = await args.publicClient.estimateFeesPerGas()

        if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas) {
          throw new Error(
            'Could not estimate Base gas fees for the revoke operation.',
          )
        }

        return {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      },
    },
  }) as any
  const sender = await bundlerSmartAccount.getAddress()
  const [{ factory, factoryData }, nonce, callData, fees] = await Promise.all([
    bundlerSmartAccount.getFactoryArgs(),
    bundlerSmartAccount.getNonce?.() ?? Promise.resolve(0n),
    bundlerSmartAccount.encodeCalls([
      {
        to: environment.DelegationManager as Address,
        data: disableDelegationCallData,
        value: 0n,
      },
    ]),
    args.publicClient.estimateFeesPerGas(),
  ])

  if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas) {
    throw new Error('Could not estimate Base gas fees for the revoke operation.')
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
    await bundlerSmartAccount.getStubSignature(baseUserOperation)
  let gas: {
    callGasLimit: bigint
    verificationGasLimit: bigint
    preVerificationGas: bigint
  }

  try {
    gas = await bundlerClient.estimateUserOperationGas({
      ...baseUserOperation,
      signature: stubSignature,
      entryPointAddress: bundlerSmartAccount.entryPoint.address,
    })
  } catch (error) {
    throw normalizeBundlerRpcError({
      chainId: args.chainId,
      chainName: args.chain.name,
      bundlerUrl: args.bundlerUrl,
      chain: args.chain,
      error,
    })
  }

  const signature = await bundlerSmartAccount.signUserOperation({
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
      entryPointAddress: bundlerSmartAccount.entryPoint.address,
    })
    receipt = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    })
  } catch (error) {
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
        'The smart-account revoke operation reverted onchain.',
    )
  }

  return receipt.receipt.transactionHash
}

export async function revokeDelegatedBudgetWithWallet(args: {
  chainId: number
  bundlerUrl: string
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
    const txHash = await sendDisableDelegationUserOperation({
      chain,
      chainId: args.chainId,
      bundlerUrl: args.bundlerUrl,
      publicClient,
      smartAccount,
      delegation,
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
