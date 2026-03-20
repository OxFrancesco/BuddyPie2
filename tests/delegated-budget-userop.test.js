import { describe, expect, mock, test } from 'bun:test'

describe('sendDisableDelegationUserOperation', () => {
  test('encodes disableDelegation and sends it through the bundler client', async () => {
    const bundlerConfigs = []
    const estimatedUserOperations = []
    const sentUserOperations = []
    const waitedReceipts = []
    const encodedDelegations = []
    const encodedCalls = []
    const signedUserOperations = []
    const stubSignatureInputs = []

    mock.module('viem', () => ({
      http: (url) => ({ transport: 'http', url }),
    }))

    mock.module('@metamask/delegation-toolkit', () => ({
      getDeleGatorEnvironment: () => ({
        DelegationManager: '0x1111111111111111111111111111111111111111',
      }),
      contracts: {
        DelegationManager: {
          encode: {
            disableDelegation: ({ delegation }) => {
              encodedDelegations.push(delegation)
              return '0xdeadbeef'
            },
          },
        },
      },
    }))

    mock.module('viem/account-abstraction', () => ({
      createBundlerClient: (config) => {
        bundlerConfigs.push(config)
        return {
          estimateUserOperationGas: async (params) => {
            estimatedUserOperations.push(params)
            return {
              callGasLimit: 111n,
              verificationGasLimit: 222n,
              preVerificationGas: 333n,
            }
          },
          sendUserOperation: async (params) => {
            sentUserOperations.push(params)
            return '0xuserop'
          },
          waitForUserOperationReceipt: async (params) => {
            waitedReceipts.push(params)
            return {
              success: true,
              receipt: {
                status: 'success',
                transactionHash:
                  '0x2222222222222222222222222222222222222222222222222222222222222222',
              },
            }
          },
        }
      },
    }))

    const { sendDisableDelegationUserOperation } = await import(
      '../src/lib/billing/delegated-budget-client.ts'
    )

    const txHash = await sendDisableDelegationUserOperation({
      chain: {
        id: 84532,
        name: 'Base Sepolia',
      },
      chainId: 84532,
      bundlerUrl: 'https://bundler.example',
      publicClient: {
        estimateFeesPerGas: async () => ({
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 2n,
        }),
      },
      smartAccount: {
        entryPoint: {
          address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        getAddress: async () =>
          '0x3333333333333333333333333333333333333333',
        getFactoryArgs: async () => ({
          factory: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          factoryData: '0xcafe',
        }),
        getNonce: async () => 7n,
        getStubSignature: async (params) => {
          stubSignatureInputs.push(params)
          return '0xstub'
        },
        encodeCalls: async (calls) => {
          encodedCalls.push(calls)
          return '0xencodedcalls'
        },
        signUserOperation: async (params) => {
          signedUserOperations.push(params)
          return '0xsigned'
        },
      },
      delegation: {
        delegator: '0x4444444444444444444444444444444444444444',
      },
    })

    expect(txHash).toBe(
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    )
    expect(encodedDelegations).toEqual([
      {
        delegator: '0x4444444444444444444444444444444444444444',
      },
    ])
    expect(bundlerConfigs).toHaveLength(1)
    expect(bundlerConfigs[0].transport).toEqual({
      transport: 'http',
      url: 'https://bundler.example',
    })
    expect(encodedCalls).toEqual([
      [
        {
          to: '0x1111111111111111111111111111111111111111',
          data: '0xdeadbeef',
          value: 0n,
        },
      ],
    ])
    expect(stubSignatureInputs).toEqual([
      {
        sender: '0x3333333333333333333333333333333333333333',
        nonce: 7n,
        callData: '0xencodedcalls',
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 2n,
        factory: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        factoryData: '0xcafe',
      },
    ])
    expect(estimatedUserOperations).toEqual([
      {
        sender: '0x3333333333333333333333333333333333333333',
        nonce: 7n,
        callData: '0xencodedcalls',
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 2n,
        factory: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        factoryData: '0xcafe',
        signature: '0xstub',
        entryPointAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ])
    expect(signedUserOperations).toEqual([
      {
        sender: '0x3333333333333333333333333333333333333333',
        nonce: 7n,
        callData: '0xencodedcalls',
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 2n,
        factory: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        factoryData: '0xcafe',
        callGasLimit: 111n,
        verificationGasLimit: 222n,
        preVerificationGas: 333n,
        chainId: 84532,
      },
    ])
    expect(sentUserOperations).toEqual([
      {
        sender: '0x3333333333333333333333333333333333333333',
        nonce: 7n,
        callData: '0xencodedcalls',
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 2n,
        factory: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        factoryData: '0xcafe',
        callGasLimit: 111n,
        verificationGasLimit: 222n,
        preVerificationGas: 333n,
        signature: '0xsigned',
        entryPointAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ])
    expect(waitedReceipts).toEqual([{ hash: '0xuserop' }])
  })

  test('throws a config error when the bundler URL points at the Base Sepolia RPC', async () => {
    const bundlerConfigs = []

    mock.module('viem', () => ({
      http: (url) => ({ transport: 'http', url }),
    }))

    mock.module('@metamask/delegation-toolkit', () => ({
      getDeleGatorEnvironment: () => ({
        DelegationManager: '0x1111111111111111111111111111111111111111',
      }),
      contracts: {
        DelegationManager: {
          encode: {
            disableDelegation: () => '0xdeadbeef',
          },
        },
      },
    }))

    mock.module('viem/account-abstraction', () => ({
      createBundlerClient: (config) => {
        bundlerConfigs.push(config)
        return {}
      },
    }))

    const { sendDisableDelegationUserOperation } = await import(
      '../src/lib/billing/delegated-budget-client.ts'
    )

    await expect(
      sendDisableDelegationUserOperation({
        chain: {
          id: 84532,
          name: 'Base Sepolia',
        },
        chainId: 84532,
        bundlerUrl: 'https://sepolia.base.org',
        publicClient: {
          estimateFeesPerGas: async () => ({
            maxFeePerGas: 10n,
            maxPriorityFeePerGas: 2n,
          }),
        },
        smartAccount: {
          entryPoint: {
            address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          getAddress: async () =>
            '0x3333333333333333333333333333333333333333',
          getFactoryArgs: async () => ({}),
          getNonce: async () => 7n,
          getStubSignature: async () => '0xstub',
          encodeCalls: async () => '0xencodedcalls',
          signUserOperation: async () => '0xsigned',
        },
        delegation: {
          delegator: '0x4444444444444444444444444444444444444444',
        },
      }),
    ).rejects.toThrow(
      'Bundler misconfiguration: delegated-budget bundler URL https://sepolia.base.org points to a standard Base Sepolia RPC endpoint',
    )

    expect(bundlerConfigs).toHaveLength(0)
  })

  test('throws a config error when the bundler URL is empty', async () => {
    const bundlerConfigs = []

    mock.module('viem', () => ({
      http: (url) => ({ transport: 'http', url }),
    }))

    mock.module('@metamask/delegation-toolkit', () => ({
      getDeleGatorEnvironment: () => ({
        DelegationManager: '0x1111111111111111111111111111111111111111',
      }),
      contracts: {
        DelegationManager: {
          encode: {
            disableDelegation: () => '0xdeadbeef',
          },
        },
      },
    }))

    mock.module('viem/account-abstraction', () => ({
      createBundlerClient: (config) => {
        bundlerConfigs.push(config)
        return {}
      },
    }))

    const { sendDisableDelegationUserOperation } = await import(
      '../src/lib/billing/delegated-budget-client.ts'
    )

    await expect(
      sendDisableDelegationUserOperation({
        chain: {
          id: 84532,
          name: 'Base Sepolia',
        },
        chainId: 84532,
        bundlerUrl: '',
        publicClient: {
          estimateFeesPerGas: async () => ({
            maxFeePerGas: 10n,
            maxPriorityFeePerGas: 2n,
          }),
        },
        smartAccount: {
          entryPoint: {
            address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          getAddress: async () =>
            '0x3333333333333333333333333333333333333333',
          getFactoryArgs: async () => ({}),
          getNonce: async () => 7n,
          getStubSignature: async () => '0xstub',
          encodeCalls: async () => '0xencodedcalls',
          signUserOperation: async () => '0xsigned',
        },
        delegation: {
          delegator: '0x4444444444444444444444444444444444444444',
        },
      }),
    ).rejects.toThrow(
      'Bundler misconfiguration: delegated-budget bundler URL is (empty). Configure DELEGATED_BUDGET_BUNDLER_URL to a bundler RPC such as https://public.pimlico.io/v2/84532/rpc, then refresh BuddyPie and try again.',
    )

    expect(bundlerConfigs).toHaveLength(0)
  })

  test('throws a config error when the endpoint rejects bundler RPC methods', async () => {
    mock.module('viem', () => ({
      http: (url) => ({ transport: 'http', url }),
    }))

    mock.module('@metamask/delegation-toolkit', () => ({
      getDeleGatorEnvironment: () => ({
        DelegationManager: '0x1111111111111111111111111111111111111111',
      }),
      contracts: {
        DelegationManager: {
          encode: {
            disableDelegation: () => '0xdeadbeef',
          },
        },
      },
    }))

    mock.module('viem/account-abstraction', () => ({
      createBundlerClient: () => ({
        estimateUserOperationGas: async () => {
          throw new Error(
            'HTTP request failed. Details: {"code":-32601,"message":"rpc method is unsupported"} method: eth_estimateUserOperationGas',
          )
        },
      }),
    }))

    const { sendDisableDelegationUserOperation } = await import(
      '../src/lib/billing/delegated-budget-client.ts'
    )

    await expect(
      sendDisableDelegationUserOperation({
        chain: {
          id: 84532,
          name: 'Base Sepolia',
        },
        chainId: 84532,
        bundlerUrl: 'https://rpc.provider.example/base-sepolia',
        publicClient: {
          estimateFeesPerGas: async () => ({
            maxFeePerGas: 10n,
            maxPriorityFeePerGas: 2n,
          }),
        },
        smartAccount: {
          entryPoint: {
            address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          getAddress: async () =>
            '0x3333333333333333333333333333333333333333',
          getFactoryArgs: async () => ({}),
          getNonce: async () => 7n,
          getStubSignature: async () => '0xstub',
          encodeCalls: async () => '0xencodedcalls',
          signUserOperation: async () => '0xsigned',
        },
        delegation: {
          delegator: '0x4444444444444444444444444444444444444444',
        },
      }),
    ).rejects.toThrow(
      'Bundler misconfiguration: delegated-budget bundler URL https://rpc.provider.example/base-sepolia does not support the ERC-4337 bundler methods BuddyPie needs on Base Sepolia',
    )
  })
})
