import { createCaveat, createDelegation, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { createTimestampTerms, hashDelegation } from '@metamask/delegation-core'
import type { Address } from 'viem'
import {
  concat,
  pad,
  toFunctionSelector,
  toHex,
} from 'viem'
import {
  advanceDelegatedBudgetPeriodEndMs,
  buildDelegatedBudgetId,
  delegatedBudgetIntervalToDurationSeconds,
  type DelegatedBudgetInterval,
  type DelegatedBudgetType,
  usdCentsToUsdcAtomic,
} from '~/lib/billing/delegated-budget-contract'

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
  args: DelegatedBudgetSetupArgs,
): Promise<DelegatedBudgetSetupResult> {
  const ethereum = window.ethereum

  if (!ethereum) {
    throw new Error('Install MetaMask before setting up a delegated budget.')
  }

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
  const currentChainId = await walletClientWithoutAccount.getChainId()

  if (currentChainId !== args.chainId) {
    try {
      await walletClientWithoutAccount.switchChain({ id: args.chainId })
    } catch {
      throw new Error(`Switch MetaMask to ${chain.name} before continuing.`)
    }
  }

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
  const smartAccount = await toolkit.toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: toolkit.Implementation.Hybrid,
    deployParams: [normalizedOwnerAddress, [], [], []],
    deploySalt: '0x',
    signer: { walletClient: walletClient as never },
  })
  const delegatorSmartAccount = viem.getAddress(smartAccount.address)
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
  })
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
    ...(args.budgetType === 'periodic' ? { interval: args.interval ?? null } : {}),
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
  }
}

export async function revokeDelegatedBudgetWithWallet(args: {
  chainId: number
  delegationJson: string
}) {
  const ethereum = window.ethereum

  if (!ethereum) {
    throw new Error('Install MetaMask before revoking a delegated budget.')
  }

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
  const currentChainId = await walletClientWithoutAccount.getChainId()

  if (currentChainId !== args.chainId) {
    try {
      await walletClientWithoutAccount.switchChain({ id: args.chainId })
    } catch {
      throw new Error(`Switch MetaMask to ${chain.name} before continuing.`)
    }
  }

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
  const delegation = JSON.parse(args.delegationJson) as Parameters<
    typeof toolkit.contracts.DelegationManager.execute.disableDelegation
  >[0]['delegation']
  const environment = toolkit.getDeleGatorEnvironment(args.chainId)
  const txHash = await toolkit.contracts.DelegationManager.execute.disableDelegation(
    {
      client: walletClient as never,
      delegationManagerAddress: environment.DelegationManager as Address,
      delegation,
    },
  )

  return {
    txHash,
  }
}
