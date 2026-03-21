import { describe, expect, test } from 'bun:test'
import {
  assertSufficientSmartAccountUsdcBalance,
  assertSufficientSmartAccountNativeBalance,
  buildDelegatedBudgetCaveats,
  deployMetaMaskSmartAccountIfNeeded,
  topUpSmartAccountGasIfNeeded,
  topUpSmartAccountUsdcIfNeeded,
} from '../src/lib/billing/delegated-budget-client.ts'

describe('deployMetaMaskSmartAccountIfNeeded', () => {
  test('skips deployment when the smart account is already deployed', async () => {
    const publicClient = {
      getCode: async () => '0x1234',
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    }
    const walletClient = {
      sendTransaction: async () => {
        throw new Error('should not send a deployment transaction')
      },
    }
    const smartAccount = {
      getFactoryArgs: async () => {
        throw new Error('should not read factory args for deployed accounts')
      },
    }

    await expect(
      deployMetaMaskSmartAccountIfNeeded({
        publicClient,
        walletClient,
        smartAccount,
        ownerAddress: '0x1111111111111111111111111111111111111111',
        address: '0x2222222222222222222222222222222222222222',
      }),
    ).resolves.toBeNull()
  })

  test('deploys the smart account through the factory when it is still counterfactual', async () => {
    const codes = ['0x', '0x1234']
    const sentTransactions = []
    const publicClient = {
      getCode: async () => codes.shift(),
      waitForTransactionReceipt: async ({ hash }) => ({
        status: hash === '0xdeploy' ? 'success' : 'reverted',
      }),
    }
    const walletClient = {
      sendTransaction: async (tx) => {
        sentTransactions.push(tx)
        return '0xdeploy'
      },
    }
    const smartAccount = {
      getFactoryArgs: async () => ({
        factory: '0x3333333333333333333333333333333333333333',
        factoryData: '0xabcdef',
      }),
    }

    await expect(
      deployMetaMaskSmartAccountIfNeeded({
        publicClient,
        walletClient,
        smartAccount,
        ownerAddress: '0x1111111111111111111111111111111111111111',
        address: '0x2222222222222222222222222222222222222222',
      }),
    ).resolves.toBe('0xdeploy')

    expect(sentTransactions).toEqual([
      {
        account: '0x1111111111111111111111111111111111111111',
        to: '0x3333333333333333333333333333333333333333',
        data: '0xabcdef',
        value: 0n,
      },
    ])
  })
})

describe('assertSufficientSmartAccountNativeBalance', () => {
  test('returns the native balance when the smart account can pay gas', async () => {
    const publicClient = {
      getBalance: async () => 123n,
    }

    await expect(
      assertSufficientSmartAccountNativeBalance({
        publicClient,
        smartAccountAddress: '0x2222222222222222222222222222222222222222',
        chainName: 'Base Sepolia',
        actionLabel: 'resetting this delegated budget',
      }),
    ).resolves.toBe(123n)
  })

  test('throws a gas-specific error when the smart account has no Base ETH', async () => {
    const publicClient = {
      getBalance: async () => 0n,
    }

    await expect(
      assertSufficientSmartAccountNativeBalance({
        publicClient,
        smartAccountAddress: '0x2222222222222222222222222222222222222222',
        chainName: 'Base Sepolia',
        actionLabel: 'resetting this delegated budget',
      }),
    ).rejects.toThrow(
      'Your MetaMask smart account has no Base ETH on Base Sepolia.',
    )
  })
})

describe('assertSufficientSmartAccountUsdcBalance', () => {
  test('waits briefly for incoming USDC before failing', async () => {
    let balanceCalls = 0
    const publicClient = {
      readContract: async () => {
        balanceCalls += 1
        return balanceCalls < 3 ? 0n : 20_000_000n
      },
    }

    await expect(
      assertSufficientSmartAccountUsdcBalance({
        publicClient,
        tokenAddress: '0x3333333333333333333333333333333333333333',
        smartAccountAddress: '0x2222222222222222222222222222222222222222',
        requiredAmountUsdCents: 2000,
        chainName: 'Base Sepolia',
        actionLabel: 'creating this delegated budget',
        waitForFundingMs: 5,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe(20_000_000n)
  })
})

describe('buildDelegatedBudgetCaveats', () => {
  test('uses settlement-contract-safe caveats instead of ERC20 transfer enforcers', () => {
    expect(
      buildDelegatedBudgetCaveats({
        backendDelegateAddress: '0x1111111111111111111111111111111111111111',
        nowSeconds: 1_700_000_000,
        delegationExpiresAtSeconds: 1_800_000_000,
      }),
    ).toEqual([
      {
        type: 'redeemer',
        redeemers: ['0x1111111111111111111111111111111111111111'],
      },
      {
        type: 'timestamp',
        afterThreshold: 1_699_999_940,
        beforeThreshold: 1_800_000_000,
      },
      {
        type: 'valueLte',
        maxValue: 0n,
      },
    ])
  })
})

describe('topUpSmartAccountUsdcIfNeeded', () => {
  test('transfers the missing USDC from the connected wallet to the smart account', async () => {
    const sentTransactions = []
    let smartAccountCalls = 0
    const publicClient = {
      readContract: async ({ args }) => {
        const address = args[0]

        if (address === '0x2222222222222222222222222222222222222222') {
          smartAccountCalls += 1
          return smartAccountCalls < 3 ? 0n : 20_000_000n
        }

        return 20_000_000n
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    }
    const walletClient = {
      sendTransaction: async (tx) => {
        sentTransactions.push(tx)
        return '0xtopup'
      },
    }

    await expect(
      topUpSmartAccountUsdcIfNeeded({
        publicClient,
        walletClient,
        tokenAddress: '0x3333333333333333333333333333333333333333',
        walletAddress: '0x1111111111111111111111111111111111111111',
        smartAccountAddress: '0x2222222222222222222222222222222222222222',
        requiredAmountUsdCents: 2000,
        chainName: 'Base Sepolia',
        waitForIncomingFundingMs: 25,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeNull()

    expect(sentTransactions).toEqual([])
  })

  test('sends the top-up transaction when the balance does not arrive in time', async () => {
    const sentTransactions = []
    let smartAccountCalls = 0
    const publicClient = {
      readContract: async ({ args }) => {
        const address = args[0]

        if (address === '0x2222222222222222222222222222222222222222') {
          smartAccountCalls += 1
          return smartAccountCalls < 4 ? 0n : 20_000_000n
        }

        return 20_000_000n
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    }
    const walletClient = {
      sendTransaction: async (tx) => {
        sentTransactions.push(tx)
        return '0xtopup'
      },
    }

    await expect(
      topUpSmartAccountUsdcIfNeeded({
        publicClient,
        walletClient,
        tokenAddress: '0x3333333333333333333333333333333333333333',
        walletAddress: '0x1111111111111111111111111111111111111111',
        smartAccountAddress: '0x2222222222222222222222222222222222222222',
        requiredAmountUsdCents: 2000,
        chainName: 'Base Sepolia',
        waitForIncomingFundingMs: 1,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe('0xtopup')

    expect(sentTransactions).toEqual([
      {
        account: '0x1111111111111111111111111111111111111111',
        to: '0x3333333333333333333333333333333333333333',
        data: expect.any(String),
        value: 0n,
      },
    ])
  })
})

describe('topUpSmartAccountGasIfNeeded', () => {
  test('sends Base ETH from the connected wallet when the smart account has no gas', async () => {
    const sentTransactions = []
    let balanceCalls = 0
    const publicClient = {
      getBalance: async () => {
        balanceCalls += 1
        return balanceCalls === 1 ? 0n : 1_000_000_000_000_000n
      },
      waitForTransactionReceipt: async () => ({ status: 'success' }),
    }
    const walletClient = {
      sendTransaction: async (tx) => {
        sentTransactions.push(tx)
        return '0xgas'
      },
    }

    await expect(
      topUpSmartAccountGasIfNeeded({
        publicClient,
        walletClient,
        walletAddress: '0x1111111111111111111111111111111111111111',
        smartAccountAddress: '0x2222222222222222222222222222222222222222',
        chainName: 'Base Sepolia',
      }),
    ).resolves.toBe('0xgas')

    expect(sentTransactions).toEqual([
      {
        account: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        data: '0x',
        value: 200000000000000n,
      },
    ])
  })
})
