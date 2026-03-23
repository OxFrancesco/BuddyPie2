import { useEffect, useState } from 'react'
import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { DeleteSandboxModal } from '~/components/delete-sandbox-modal'
import { readCurrentDelegatedBudgetHealth } from '~/features/billing/server'
import {
  deleteSandbox,
  readSandboxArtifact,
  restartSandbox,
  sendSandboxAgentPrompt,
} from '~/features/sandboxes/server'
import { SandboxMissingState } from '~/features/sandboxes/detail/components/SandboxMissingState'
import { SandboxSummaryCard } from '~/features/sandboxes/detail/components/SandboxSummaryCard'
import { SandboxUtilityDrawer } from '~/features/sandboxes/detail/components/SandboxUtilityDrawer'
import { SandboxWorkspaceFrame } from '~/features/sandboxes/detail/components/SandboxWorkspaceFrame'
import { useSandboxPreview } from '~/features/sandboxes/detail/useSandboxPreview'
import { useSandboxTerminalAccess } from '~/features/sandboxes/detail/useSandboxTerminalAccess'
import { useSandboxUtilityDrawer } from '~/features/sandboxes/detail/useSandboxUtilityDrawer'
import type {
  DelegatedBudgetSummary,
  RestartResult,
  SandboxDetailRecord,
} from '~/features/sandboxes/detail/types'
import { formatRemainingBudgetDisplay } from '~/features/sandboxes/detail/utils'
import { postJsonWithX402Payment } from '~/lib/billing/x402-client'
import {
  getOpenCodeModelOptionByProviderAndModel,
  getSafeOpenCodeAgentPreset,
} from '~/lib/opencode/presets'
import {
  isX402SandboxPaymentMethod,
  type SandboxPaymentMethod,
} from '~/lib/sandboxes'

export const Route = createFileRoute('/_authed/sandboxes/$sandboxId')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(
        convexQuery(api.sandboxes.get, {
          sandboxId: params.sandboxId as Id<'sandboxes'>,
        }),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.sandboxUsage, {
          sandboxId: params.sandboxId as Id<'sandboxes'>,
        }),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.dashboardSummary, {}),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.pricingCatalog, {}),
      ),
    ])
  },
  component: SandboxDetailRoute,
})

function SandboxDetailRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const params = Route.useParams()
  const { data: sandboxData } = useSuspenseQuery(
    convexQuery(api.sandboxes.get, {
      sandboxId: params.sandboxId as Id<'sandboxes'>,
    }),
  )
  const { data: sandboxUsage } = useSuspenseQuery(
    convexQuery(api.billing.sandboxUsage, {
      sandboxId: params.sandboxId as Id<'sandboxes'>,
    }),
  )
  const { data: billingSummary } = useSuspenseQuery(
    convexQuery(api.billing.dashboardSummary, {}),
  )
  const { data: pricingCatalog } = useSuspenseQuery(
    convexQuery(api.billing.pricingCatalog, {}),
  )
  const sandbox = (sandboxData as SandboxDetailRecord | null) ?? null
  const [paymentMethod, setPaymentMethod] =
    useState<SandboxPaymentMethod>('credits')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)

  const billingSummaryView = billingSummary as typeof billingSummary & {
    delegatedBudget?: DelegatedBudgetSummary
  }
  const delegatedBudget = billingSummaryView.delegatedBudget
  const delegatedBudgetHealthQuery = useQuery({
    queryKey: ['billing', 'delegated-budget-health'],
    queryFn: () => readCurrentDelegatedBudgetHealth(),
    staleTime: 15_000,
  })
  const delegatedBudgetHealth = delegatedBudgetHealthQuery.data
  const artifactQuery = useQuery({
    queryKey: ['sandbox', sandbox?._id ?? 'none', 'artifact'],
    queryFn: () =>
      readSandboxArtifact({
        data: {
          sandboxId: sandbox!._id,
        },
      }),
    enabled:
      Boolean(sandbox?._id) &&
      sandbox?.status === 'ready' &&
      Boolean(sandbox?.daytonaSandboxId) &&
      Boolean(sandbox?.workspacePath),
    refetchInterval: 5_000,
    staleTime: 0,
  })
  const remainingBudgetDisplay = formatRemainingBudgetDisplay(delegatedBudget)
  const hasActiveDelegatedBudget =
    delegatedBudget?.status === 'active' &&
    delegatedBudgetHealth?.health === 'usable'
  const pendingPaymentMethod = sandbox?.pendingPaymentMethod as
    | SandboxPaymentMethod
    | undefined

  useEffect(() => {
    setPaymentMethod(
      pendingPaymentMethod === 'x402'
        ? 'x402'
        : pendingPaymentMethod === 'delegated_budget'
          ? 'delegated_budget'
          : 'credits',
    )
  }, [pendingPaymentMethod, sandbox?._id])

  const x402ChainId =
    sandboxUsage.wallet?.chainId ?? pricingCatalog.environment.chainId
  const preset = getSafeOpenCodeAgentPreset(sandbox?.agentPresetId)
  const presetLabel = sandbox?.agentLabel ?? preset.label
  const modelOption = getOpenCodeModelOptionByProviderAndModel(
    sandbox?.agentProvider,
    sandbox?.agentModel,
  )
  const providerLabel =
    modelOption?.providerLabel ?? sandbox?.agentProvider ?? preset.provider
  const modelLabel =
    modelOption?.modelLabel ?? sandbox?.agentModel ?? preset.model

  async function refreshSandboxQueries() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.sandboxes.list, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.sandboxes.get, {
          sandboxId: params.sandboxId as Id<'sandboxes'>,
        }).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.billing.sandboxUsage, {
          sandboxId: params.sandboxId as Id<'sandboxes'>,
        }).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.billing.dashboardSummary, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: ['billing', 'delegated-budget-health'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['sandbox', params.sandboxId, 'artifact'],
      }),
    ])
  }

  async function handleSendArtifactFixPrompt(prompt: string) {
    if (!sandbox) {
      return
    }

    await sendSandboxAgentPrompt({
      data: {
        sandboxId: sandbox._id,
        prompt,
      },
    })
  }

  function blockDelegatedBudgetAction() {
    setError(
      delegatedBudgetHealth?.message ??
        'Set up a healthy delegated budget before using that payment rail.',
    )
    void navigate({
      to: '/profile',
      hash: 'delegated-budget',
    })
  }

  async function handleDelete() {
    if (!sandbox) {
      return
    }

    setIsBusy(true)
    setError(null)

    try {
      await deleteSandbox({
        data: { sandboxId: sandbox._id },
      })
      await refreshSandboxQueries()
      await navigate({ to: '/dashboard' })
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Could not delete this sandbox.',
      )
    } finally {
      setIsBusy(false)
    }
  }

  async function handleRestart() {
    if (!sandbox) {
      return
    }

    setIsBusy(true)
    setError(null)

    if (paymentMethod === 'delegated_budget' && !hasActiveDelegatedBudget) {
      blockDelegatedBudgetAction()
      setIsBusy(false)
      return
    }

    try {
      const restarted = isX402SandboxPaymentMethod(paymentMethod)
        ? await postJsonWithX402Payment<RestartResult>({
            url: `/api/x402/sandboxes/${sandbox._id}/restart`,
            body: {},
            chainId: x402ChainId,
          })
        : await restartSandbox({
            data: {
              sandboxId: sandbox._id,
              paymentMethod,
            } as any,
          })

      await refreshSandboxQueries()
      await navigate({
        to: '/sandboxes/$sandboxId',
        params: { sandboxId: restarted.sandboxId },
      })
    } catch (restartError) {
      setError(
        restartError instanceof Error
          ? restartError.message
          : 'Could not restart this sandbox.',
      )
    } finally {
      setIsBusy(false)
    }
  }

  const utilityDrawer = useSandboxUtilityDrawer({
    sandboxId: sandbox?._id,
    agentPresetId: sandbox?.agentPresetId,
  })
  const preview = useSandboxPreview({
    sandbox,
    paymentMethod,
    hasActiveDelegatedBudget,
    delegatedBudgetHealth,
    x402ChainId,
    isPreviewPanelOpen: utilityDrawer.isPreviewPanelOpen,
    utilityDrawerTab: utilityDrawer.utilityDrawerTab,
    refreshSandboxQueries,
  })
  const terminal = useSandboxTerminalAccess({
    sandbox,
    paymentMethod,
    hasActiveDelegatedBudget,
    delegatedBudgetHealthMessage: delegatedBudgetHealth?.message,
    x402ChainId,
    refreshSandboxQueries,
    onDelegatedBudgetBlocked: blockDelegatedBudgetAction,
  })

  if (!sandbox) {
    return <SandboxMissingState />
  }

  if (sandbox.status === 'creating') {
    return (
      <main className="flex flex-col gap-6">
        <SandboxSummaryCard
          sandbox={sandbox}
          presetLabel={presetLabel}
          paymentMethod={paymentMethod}
          providerLabel={providerLabel}
          modelLabel={modelLabel}
          remainingBudgetDisplay={remainingBudgetDisplay}
          error={error}
          isBusy={isBusy}
          onRestart={handleRestart}
          onDelete={() => setShowDeleteModal(true)}
          footer={
            <div className="flex min-h-[420px] flex-col items-center justify-center border-2 border-foreground bg-muted/40 px-6 py-12 text-center">
              <div className="relative h-20 w-20">
                <div className="absolute inset-0 animate-spin rounded-full border-4 border-foreground border-t-transparent" />
                <div className="absolute inset-[18px] animate-pulse rounded-full bg-accent" />
              </div>
              <h3 className="mt-8 text-2xl font-black uppercase">
                Preparing workspace...
              </h3>
              <p className="mt-4 max-w-md text-sm text-muted-foreground">
                The sandbox is still provisioning. BuddyPie will keep the
                workspace locked until OpenCode is reachable.
              </p>
              <p className="mt-2 max-w-md text-xs font-bold uppercase tracking-widest text-muted-foreground">
                The embedded preview will appear automatically once the sandbox
                is ready.
              </p>
            </div>
          }
        />

        <DeleteSandboxModal
          open={showDeleteModal}
          onOpenChange={setShowDeleteModal}
          onConfirm={handleDelete}
          sandboxName={sandbox.repoName}
        />
      </main>
    )
  }

  return (
    <main className="flex flex-col gap-6">
      <SandboxSummaryCard
        sandbox={sandbox}
        presetLabel={presetLabel}
        paymentMethod={paymentMethod}
        providerLabel={providerLabel}
        modelLabel={modelLabel}
        remainingBudgetDisplay={remainingBudgetDisplay}
        error={error}
        showDelegatedBudgetLink={
          paymentMethod === 'delegated_budget' && !hasActiveDelegatedBudget
        }
        isBusy={isBusy}
        onRestart={handleRestart}
        onDelete={() => setShowDeleteModal(true)}
      />

      <SandboxWorkspaceFrame sandbox={sandbox} />

      <button
        type="button"
        onClick={() => utilityDrawer.setIsPreviewPanelOpen(true)}
        onTouchStart={(event) =>
          utilityDrawer.handleEdgeSwipeStart(event.touches[0]?.clientX ?? 0)
        }
        onTouchEnd={(event) =>
          utilityDrawer.handleEdgeSwipeEnd(
            event.changedTouches[0]?.clientX ?? 0,
          )
        }
        className="fixed right-0 top-1/2 z-30 -translate-y-1/2 rounded-l-xl border-2 border-r-0 border-foreground bg-accent px-3 py-5 text-xs font-black uppercase tracking-widest text-accent-foreground shadow-[-3px_3px_0_var(--foreground)] [writing-mode:vertical-rl]"
        aria-label="Open artifacts and app preview panel"
      >
        Artifacts & Preview
      </button>

      {!utilityDrawer.isPreviewPanelOpen ? (
        <div
          className="fixed inset-y-0 right-0 z-20 w-4"
          onTouchStart={(event) =>
            utilityDrawer.handleEdgeSwipeStart(event.touches[0]?.clientX ?? 0)
          }
          onTouchEnd={(event) =>
            utilityDrawer.handleEdgeSwipeEnd(
              event.changedTouches[0]?.clientX ?? 0,
            )
          }
        />
      ) : null}

      <SandboxUtilityDrawer
        sandbox={sandbox}
        isOpen={utilityDrawer.isPreviewPanelOpen}
        onClose={() => utilityDrawer.setIsPreviewPanelOpen(false)}
        utilityDrawerTab={utilityDrawer.utilityDrawerTab}
        setUtilityDrawerTab={utilityDrawer.setUtilityDrawerTab}
        handlePanelSwipeStart={utilityDrawer.handlePanelSwipeStart}
        handlePanelSwipeEnd={utilityDrawer.handlePanelSwipeEnd}
        artifact={{
          result: artifactQuery.data,
          isLoading: artifactQuery.isLoading,
          error: artifactQuery.error,
        }}
        onSendArtifactFixPrompt={handleSendArtifactFixPrompt}
        paymentMethod={paymentMethod}
        hasActiveDelegatedBudget={hasActiveDelegatedBudget}
        preview={preview}
        terminal={terminal}
      />

      <DeleteSandboxModal
        open={showDeleteModal}
        onOpenChange={setShowDeleteModal}
        onConfirm={handleDelete}
        sandboxName={sandbox.repoName}
      />
    </main>
  )
}
