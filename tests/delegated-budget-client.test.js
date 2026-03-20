import { describe, expect, test } from 'bun:test'
import {
  assertSufficientSmartAccountNativeBalance,
  deployMetaMaskSmartAccountIfNeeded,
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
