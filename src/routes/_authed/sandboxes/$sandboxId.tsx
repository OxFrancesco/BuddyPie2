import { useEffect, useMemo, useRef, useState } from 'react'
import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { DelegatedBudgetManager } from '~/components/delegated-budget-manager'
import { DeleteSandboxModal } from '~/components/delete-sandbox-modal'
import { PaymentMethodToggle } from '~/components/payment-method-toggle'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { StatusPill } from '~/components/status-pill'
import { readCurrentDelegatedBudgetHealth } from '~/features/billing/server'
import {
  createTerminalAccess,
  deleteSandbox,
  ensureAppPreviewServer,
  getAppPreviewCommandSuggestion,
  getAppPreviewLogs,
  getPortPreview,
  restartSandbox,
} from '~/features/sandboxes/server'
import { formatSandboxPaymentMethod } from '~/lib/billing/presentation'
import { postJsonWithX402Payment } from '~/lib/billing/x402-client'
import {
  getOpenCodeModelOptionByProviderAndModel,
  getSafeOpenCodeAgentPreset,
} from '~/lib/opencode/presets'
import {
  isX402SandboxPaymentMethod,
  type SandboxPaymentMethod,
} from '~/lib/sandboxes'

const SWIPE_DISTANCE_PX = 60
const DEFAULT_APP_PREVIEW_PORT = '5173'
const QUICK_PREVIEW_PORTS = ['5173', '4173', '3001', '8080'] as const
const PREVIEW_TERMINAL_FALLBACK_DELAY_MS = 10_000

type PreviewBootResult = {
  status: 'already-running' | 'started'
  port: number
  previewUrl: string
}

type TerminalAccessResult = {
  sshCommand: string
  expiresAt: string | number
}

type PortPreviewResult = {
  previewUrl: string
  port: number
}

type PreviewCommandSuggestionResult = {
  command: string
  framework: string
  packageManager: string
  previewScript: string
  workspacePath: string
}

type RestartResult = {
  sandboxId: string
  previewUrl?: string
  agentPresetId: string
}

type DelegatedBudgetSummary = {
  status?: string | null
  type?: 'fixed' | 'periodic' | null
  interval?: 'day' | 'week' | 'month' | null
  token?: string | null
  network?: string | null
  configuredAmountUsdCents?: number | null
  remainingAmountUsdCents?: number | null
  periodEndsAt?: string | number | null
  delegatorSmartAccount?: string | null
  delegateAddress?: string | null
  lastSettlementAt?: string | number | null
  lastRevokedAt?: string | number | null
}

function derivePreviewUrlPattern(
  previewUrl?: string,
  previewUrlPattern?: string,
) {
  if (previewUrlPattern?.includes('{PORT}')) {
    return previewUrlPattern
  }

  if (!previewUrl || !previewUrl.includes('3000')) {
    return null
  }

  return previewUrl.replace('3000', '{PORT}')
}

function isValidPreviewPort(value: string) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65_536
}

function formatDateTime(value?: string | number | null) {
  if (!value) {
    return null
  }

  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return String(value)
  }

  return parsedDate.toLocaleString()
}

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
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.currentDelegatedBudget, {}),
      ),
    ])
  },
  component: SandboxDetailRoute,
})

function SandboxDetailRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const params = Route.useParams()
  const { data: sandbox } = useSuspenseQuery(
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
  const { data: delegatedBudgetRecord } = useSuspenseQuery(
    convexQuery(api.billing.currentDelegatedBudget, {}),
  )
  const [paymentMethod, setPaymentMethod] =
    useState<SandboxPaymentMethod>('credits')
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPreviewPanelOpen, setIsPreviewPanelOpen] = useState(false)
  const [previewPort, setPreviewPort] = useState(DEFAULT_APP_PREVIEW_PORT)
  const [isPreviewBooting, setIsPreviewBooting] = useState(false)
  const [previewBootError, setPreviewBootError] = useState<string | null>(null)
  const [previewIframeVersion, setPreviewIframeVersion] = useState(0)
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null)
  const [previewLogs, setPreviewLogs] = useState<string>('')
  const [previewLogPath, setPreviewLogPath] = useState<string | null>(null)
  const [previewLogsError, setPreviewLogsError] = useState<string | null>(null)
  const [isPreviewLogsLoading, setIsPreviewLogsLoading] = useState(false)
  const [previewLogsRequestNonce, setPreviewLogsRequestNonce] = useState(0)
  const [previewBootStartedAt, setPreviewBootStartedAt] = useState<
    number | null
  >(null)
  const [showManualPreviewFallback, setShowManualPreviewFallback] =
    useState(false)
  const [hasPreviewIframeLoaded, setHasPreviewIframeLoaded] = useState(false)
  const [previewCommandSuggestion, setPreviewCommandSuggestion] =
    useState<PreviewCommandSuggestionResult | null>(null)
  const [previewCommandSuggestionError, setPreviewCommandSuggestionError] =
    useState<string | null>(null)
  const [
    isPreviewCommandSuggestionLoading,
    setIsPreviewCommandSuggestionLoading,
  ] = useState(false)
  const [sshCommand, setSshCommand] = useState<string | null>(null)
  const [sshExpiresAt, setSshExpiresAt] = useState<string | null>(null)
  const [terminalAccessError, setTerminalAccessError] = useState<string | null>(
    null,
  )
  const [isTerminalAccessLoading, setIsTerminalAccessLoading] = useState(false)
  const [webTerminalError, setWebTerminalError] = useState<string | null>(null)
  const [isWebTerminalLoading, setIsWebTerminalLoading] = useState(false)
  const [webTerminalUrl, setWebTerminalUrl] = useState<string | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const edgeSwipeStartX = useRef<number | null>(null)
  const panelSwipeStartX = useRef<number | null>(null)
  const previewBootAttemptKeyRef = useRef<string | null>(null)
  const billingSummaryView = billingSummary as typeof billingSummary & {
    delegatedBudget?: DelegatedBudgetSummary
  }
  const delegatedBudget = billingSummaryView.delegatedBudget
  const delegatedBudgetHealthQuery = useQuery({
    queryKey: [
      'billing',
      'delegated-budget-health',
      delegatedBudgetRecord?._id ?? 'none',
    ],
    queryFn: () => readCurrentDelegatedBudgetHealth(),
    staleTime: 15_000,
  })
  const delegatedBudgetHealth = delegatedBudgetHealthQuery.data
  const hasActiveDelegatedBudget =
    delegatedBudget?.status === 'active' &&
    delegatedBudgetHealth?.health === 'usable'
  const pendingPaymentMethod =
    sandbox?.pendingPaymentMethod as SandboxPaymentMethod | undefined

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
  const previewUrlPattern = derivePreviewUrlPattern(
    sandbox?.previewUrl,
    sandbox?.previewUrlPattern,
  )
  const appPreviewUrl = useMemo(() => {
    if (activePreviewUrl) {
      return activePreviewUrl
    }

    if (!previewUrlPattern || !isValidPreviewPort(previewPort)) {
      return null
    }

    return previewUrlPattern.replace('{PORT}', previewPort)
  }, [activePreviewUrl, previewPort, previewUrlPattern])
  const appPreviewIframeUrl = useMemo(() => {
    if (!appPreviewUrl) {
      return null
    }

    const separator = appPreviewUrl.includes('?') ? '&' : '?'
    return `${appPreviewUrl}${separator}buddypiePreview=${previewIframeVersion}`
  }, [appPreviewUrl, previewIframeVersion])

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
        queryKey: convexQuery(api.billing.currentDelegatedBudget, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: ['billing', 'delegated-budget-health'],
      }),
    ])
  }

  function blockDelegatedBudgetAction() {
    setError(
      delegatedBudgetHealth?.message ??
        'Set up a healthy delegated budget before using that payment rail.',
    )
    document.getElementById('delegated-budget')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  }

  async function triggerPreviewBoot() {
    if (!sandbox || !isValidPreviewPort(previewPort)) {
      return
    }

    const port = Number(previewPort)
    setIsPreviewBooting(true)
    setPreviewBootError(null)
    setPreviewBootStartedAt(Date.now())
    setShowManualPreviewFallback(false)
    setHasPreviewIframeLoaded(false)
    setPreviewCommandSuggestion(null)
    setPreviewCommandSuggestionError(null)

    try {
      const result =
        isX402SandboxPaymentMethod(paymentMethod)
          ? await postJsonWithX402Payment<PreviewBootResult>({
              url: `/api/x402/sandboxes/${sandbox._id}/preview`,
              body: { port },
              chainId: x402ChainId,
            })
          : await ensureAppPreviewServer({
              data: {
                sandboxId: sandbox._id,
                port,
                paymentMethod,
              } as any,
            })

      setActivePreviewUrl(result.previewUrl ?? null)
      setPreviewIframeVersion((value) => value + 1)
      await refreshSandboxQueries()
    } catch (bootError) {
      previewBootAttemptKeyRef.current = null
      setActivePreviewUrl(null)
      setPreviewBootError(
        bootError instanceof Error
          ? bootError.message
          : 'Could not start the app preview server.',
      )
    } finally {
      setIsPreviewBooting(false)
      setPreviewLogsRequestNonce((value) => value + 1)
    }
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
      const restarted =
        isX402SandboxPaymentMethod(paymentMethod)
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

  async function handleCreateTerminalAccess() {
    if (!sandbox) {
      return
    }

    setIsTerminalAccessLoading(true)
    setTerminalAccessError(null)

    if (paymentMethod === 'delegated_budget' && !hasActiveDelegatedBudget) {
      blockDelegatedBudgetAction()
      setIsTerminalAccessLoading(false)
      return
    }

    try {
      const access =
        isX402SandboxPaymentMethod(paymentMethod)
          ? await postJsonWithX402Payment<TerminalAccessResult>({
              url: `/api/x402/sandboxes/${sandbox._id}/ssh`,
              body: {
                expiresInMinutes: 60,
              },
              chainId: x402ChainId,
            })
          : await createTerminalAccess({
              data: {
                sandboxId: sandbox._id,
                expiresInMinutes: 60,
                paymentMethod,
              } as any,
            })

      setSshCommand(access.sshCommand)
      setSshExpiresAt(String(access.expiresAt))
      await refreshSandboxQueries()
    } catch (terminalError) {
      setTerminalAccessError(
        terminalError instanceof Error
          ? terminalError.message
          : 'Could not create terminal access.',
      )
    } finally {
      setIsTerminalAccessLoading(false)
    }
  }

  async function handleOpenWebTerminal() {
    if (!sandbox) {
      return
    }

    setIsWebTerminalLoading(true)
    setWebTerminalError(null)

    if (paymentMethod === 'delegated_budget' && !hasActiveDelegatedBudget) {
      blockDelegatedBudgetAction()
      setIsWebTerminalLoading(false)
      return
    }

    try {
      const preview =
        isX402SandboxPaymentMethod(paymentMethod)
          ? await postJsonWithX402Payment<PortPreviewResult>({
              url: `/api/x402/sandboxes/${sandbox._id}/web-terminal`,
              body: {},
              chainId: x402ChainId,
            })
          : await getPortPreview({
              data: {
                sandboxId: sandbox._id,
                port: 22222,
                paymentMethod,
              } as any,
            })

      setWebTerminalUrl(preview.previewUrl)
      window.open(preview.previewUrl, '_blank', 'noopener,noreferrer')
      await refreshSandboxQueries()
    } catch (terminalError) {
      setWebTerminalError(
        terminalError instanceof Error
          ? terminalError.message
          : 'Could not open the Daytona web terminal.',
      )
    } finally {
      setIsWebTerminalLoading(false)
    }
  }

  function handleEdgeSwipeStart(touchX: number) {
    edgeSwipeStartX.current = touchX
  }

  function handleEdgeSwipeEnd(touchX: number) {
    const startX = edgeSwipeStartX.current
    edgeSwipeStartX.current = null

    if (startX === null) {
      return
    }

    if (startX - touchX > SWIPE_DISTANCE_PX) {
      setIsPreviewPanelOpen(true)
    }
  }

  function handlePanelSwipeStart(touchX: number) {
    panelSwipeStartX.current = touchX
  }

  function handlePanelSwipeEnd(touchX: number) {
    const startX = panelSwipeStartX.current
    panelSwipeStartX.current = null

    if (startX === null) {
      return
    }

    if (touchX - startX > SWIPE_DISTANCE_PX) {
      setIsPreviewPanelOpen(false)
    }
  }

  useEffect(() => {
    setActivePreviewUrl(null)
    previewBootAttemptKeyRef.current = null
    setPreviewBootStartedAt(null)
    setShowManualPreviewFallback(false)
    setHasPreviewIframeLoaded(false)
    setPreviewCommandSuggestion(null)
    setPreviewCommandSuggestionError(null)
  }, [previewPort, sandbox?._id, paymentMethod])

  useEffect(() => {
    if (!isPreviewPanelOpen) {
      setIsPreviewBooting(false)
      setPreviewBootError(null)
      setPreviewLogsError(null)
      previewBootAttemptKeyRef.current = null
      setPreviewBootStartedAt(null)
      setShowManualPreviewFallback(false)
      setHasPreviewIframeLoaded(false)
      setPreviewCommandSuggestion(null)
      setPreviewCommandSuggestionError(null)
      return
    }

    if (
      !sandbox ||
      sandbox.status !== 'ready' ||
      !isValidPreviewPort(previewPort)
    ) {
      return
    }

    if (isX402SandboxPaymentMethod(paymentMethod)) {
      return
    }

    const port = Number(previewPort)
    const attemptKey = `${sandbox._id}:${port}:${paymentMethod}`

    if (previewBootAttemptKeyRef.current === attemptKey) {
      return
    }

    previewBootAttemptKeyRef.current = attemptKey
    void triggerPreviewBoot()
  }, [isPreviewPanelOpen, paymentMethod, previewPort, sandbox])

  useEffect(() => {
    if (
      !isPreviewPanelOpen ||
      !sandbox ||
      !isValidPreviewPort(previewPort) ||
      previewBootStartedAt === null ||
      hasPreviewIframeLoaded
    ) {
      return
    }

    const remainingMs =
      PREVIEW_TERMINAL_FALLBACK_DELAY_MS -
      Math.max(0, Date.now() - previewBootStartedAt)

    if (remainingMs <= 0) {
      setShowManualPreviewFallback(true)
      return
    }

    const timeoutId = window.setTimeout(() => {
      setShowManualPreviewFallback(true)
    }, remainingMs)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    hasPreviewIframeLoaded,
    isPreviewPanelOpen,
    previewBootStartedAt,
    previewPort,
    sandbox,
  ])

  useEffect(() => {
    if (
      !showManualPreviewFallback ||
      !sandbox ||
      !isValidPreviewPort(previewPort) ||
      previewCommandSuggestion ||
      isPreviewCommandSuggestionLoading
    ) {
      return
    }

    const port = Number(previewPort)
    setIsPreviewCommandSuggestionLoading(true)
    setPreviewCommandSuggestionError(null)

    void getAppPreviewCommandSuggestion({
      data: {
        sandboxId: sandbox._id,
        port,
      },
    })
      .then((result) => {
        setPreviewCommandSuggestion(result)
      })
      .catch((commandError) => {
        setPreviewCommandSuggestionError(
          commandError instanceof Error
            ? commandError.message
            : 'Could not determine a manual preview command.',
        )
      })
      .finally(() => {
        setIsPreviewCommandSuggestionLoading(false)
      })
  }, [
    isPreviewCommandSuggestionLoading,
    previewCommandSuggestion,
    previewPort,
    sandbox,
    showManualPreviewFallback,
  ])

  useEffect(() => {
    if (hasPreviewIframeLoaded) {
      setShowManualPreviewFallback(false)
    }
  }, [hasPreviewIframeLoaded])

  useEffect(() => {
    if (!isPreviewPanelOpen || !sandbox || !isValidPreviewPort(previewPort)) {
      return
    }

    const port = Number(previewPort)
    setIsPreviewLogsLoading(true)
    setPreviewLogsError(null)

    void getAppPreviewLogs({
      data: {
        sandboxId: sandbox._id,
        port,
      },
    })
      .then((result) => {
        setPreviewLogs(result.output || 'No logs yet.')
        setPreviewLogPath(result.logPath)
      })
      .catch((logError) => {
        setPreviewLogsError(
          logError instanceof Error
            ? logError.message
            : 'Could not load app preview logs.',
        )
      })
      .finally(() => {
        setIsPreviewLogsLoading(false)
      })
  }, [isPreviewPanelOpen, previewLogsRequestNonce, previewPort, sandbox])

  if (!sandbox) {
    return (
      <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
        <CardHeader>
          <CardTitle className="text-2xl font-black uppercase">
            Workspace missing
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            This sandbox no longer exists or you don&apos;t have access.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            asChild
            className="border-2 border-foreground bg-foreground font-black uppercase text-background shadow-[3px_3px_0_var(--accent)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
          >
            <Link to="/dashboard">← Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (sandbox.status === 'creating') {
    return (
      <main className="flex flex-col gap-6">
        <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
          <CardHeader>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex flex-col gap-3">
                <Link
                  to="/dashboard"
                  className="text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  ← Dashboard
                </Link>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={sandbox.status} />
                  <Badge
                    variant="outline"
                    className="border-2 border-foreground font-bold uppercase tracking-widest"
                  >
                    {presetLabel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-2 border-foreground font-bold uppercase tracking-widest"
                  >
                    {formatSandboxPaymentMethod(paymentMethod)}
                  </Badge>
                </div>
                <CardTitle className="text-3xl font-black uppercase sm:text-4xl">
                  {sandbox.repoName}
                </CardTitle>
                <p className="break-all text-sm text-muted-foreground">
                  {sandbox.repoUrl}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  onClick={handleRestart}
                  disabled={isBusy}
                  className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
                >
                  Restart
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setShowDeleteModal(true)}
                  disabled={isBusy}
                  className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
                >
                  Delete
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {error ? (
              <Alert
                variant="destructive"
                className="mb-4 border-2 border-foreground"
              >
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="border-2 border-foreground bg-muted p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Branch
                </p>
                <p className="mt-1 font-bold">
                  {sandbox.repoBranch || 'default'}
                </p>
              </div>
              <div className="border-2 border-foreground bg-muted p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Provider
                </p>
                <p className="mt-1 font-bold">{providerLabel}</p>
              </div>
              <div className="border-2 border-foreground bg-muted p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Model
                </p>
                <p className="mt-1 break-all font-bold">{modelLabel}</p>
              </div>
              <div className="border-2 border-foreground bg-muted p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Workspace
                </p>
                <p className="mt-1 break-all font-bold">
                  {sandbox.workspacePath || 'Provisioning...'}
                </p>
              </div>
            </div>

            <div className="mt-6 flex min-h-[420px] flex-col items-center justify-center border-2 border-foreground bg-muted/40 px-6 py-12 text-center">
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
          </CardContent>
        </Card>

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
      <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
        <CardHeader>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-3">
              <Link
                to="/dashboard"
                className="text-xs font-black uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                ← Dashboard
              </Link>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={sandbox.status} />
                <Badge
                  variant="outline"
                  className="border-2 border-foreground font-bold uppercase tracking-widest"
                >
                  {presetLabel}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-2 border-foreground font-bold uppercase tracking-widest"
                >
                  {formatSandboxPaymentMethod(paymentMethod)}
                </Badge>
              </div>
              <CardTitle className="text-3xl font-black uppercase sm:text-4xl">
                {sandbox.repoName}
              </CardTitle>
              <p className="break-all text-sm text-muted-foreground">
                {sandbox.repoUrl}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={handleRestart}
                disabled={isBusy}
                className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
              >
                Restart
              </Button>
              <Button
                variant="destructive"
                onClick={() => setShowDeleteModal(true)}
                disabled={isBusy}
                className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
              >
                Delete
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {error ? (
            <Alert
              variant="destructive"
              className="mb-4 border-2 border-foreground"
            >
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="border-2 border-foreground bg-muted p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Branch
              </p>
              <p className="mt-1 font-bold">
                {sandbox.repoBranch || 'default'}
              </p>
            </div>
            <div className="border-2 border-foreground bg-muted p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Provider
              </p>
              <p className="mt-1 font-bold">{providerLabel}</p>
            </div>
            <div className="border-2 border-foreground bg-muted p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Model
              </p>
              <p className="mt-1 break-all font-bold">{modelLabel}</p>
            </div>
            <div className="border-2 border-foreground bg-muted p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Workspace
              </p>
              <p className="mt-1 break-all font-bold">
                {sandbox.workspacePath || 'Provisioning...'}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <PaymentMethodToggle
              value={paymentMethod}
              onChange={(nextValue) => {
                setError(null)
                setPaymentMethod(nextValue)
              }}
              creditsDescription="Use the shared BuddyPie wallet for preview, restart, SSH, and terminal access."
              x402Description={`Pay per action from your wallet on ${sandboxUsage.wallet?.fundingNetwork ?? 'Base'}.`}
              delegatedBudgetDescription={
                hasActiveDelegatedBudget
                  ? 'Use an active MetaMask delegated budget for the same actions.'
                  : delegatedBudgetHealth?.message ??
                    'Set up a MetaMask delegated budget before selecting this rail.'
              }
              delegatedBudgetDisabled={!hasActiveDelegatedBudget}
            />

            <DelegatedBudgetManager
              id="delegated-budget"
              summary={delegatedBudget}
              record={delegatedBudgetRecord}
              health={delegatedBudgetHealth}
              environment={pricingCatalog.environment}
              onUpdated={refreshSandboxQueries}
              onSelectRail={() => {
                setError(null)
                setPaymentMethod('delegated_budget')
              }}
              compact
            />
          </div>
        </CardContent>
      </Card>

      <div className="border-2 border-foreground bg-card shadow-[4px_4px_0_var(--foreground)]">
        {sandbox.previewUrl && sandbox.status === 'ready' ? (
          <div>
            <div className="flex items-center justify-between border-b-2 border-foreground px-5 py-3">
              <p className="text-sm font-black uppercase tracking-widest">
                OpenCode
              </p>
              <a
                href={sandbox.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-bold underline decoration-2 underline-offset-4"
              >
                New tab →
              </a>
            </div>
            <iframe
              title={`${sandbox.repoName} OpenCode workspace`}
              src={sandbox.previewUrl}
              className="h-[78vh] w-full bg-background"
            />
          </div>
        ) : (
          <div className="flex min-h-[420px] items-center justify-center p-12 text-center">
            <div className="max-w-md">
              <h3 className="text-2xl font-black uppercase">
                {sandbox.status === 'failed'
                  ? 'Workspace failed.'
                  : 'Booting workspace...'}
              </h3>
              <p className="mt-4 text-sm text-muted-foreground">
                {sandbox.errorMessage ||
                  'The embedded preview will appear here once OpenCode is reachable. Try restarting if stuck.'}
              </p>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setIsPreviewPanelOpen(true)}
        onTouchStart={(event) =>
          handleEdgeSwipeStart(event.touches[0]?.clientX ?? 0)
        }
        onTouchEnd={(event) =>
          handleEdgeSwipeEnd(event.changedTouches[0]?.clientX ?? 0)
        }
        className="fixed right-0 top-1/2 z-30 -translate-y-1/2 rounded-l-xl border-2 border-r-0 border-foreground bg-accent px-3 py-5 text-xs font-black uppercase tracking-widest text-accent-foreground shadow-[-3px_3px_0_var(--foreground)] [writing-mode:vertical-rl]"
        aria-label="Open app preview panel"
      >
        App Preview
      </button>

      {!isPreviewPanelOpen ? (
        <div
          className="fixed inset-y-0 right-0 z-20 w-4"
          onTouchStart={(event) =>
            handleEdgeSwipeStart(event.touches[0]?.clientX ?? 0)
          }
          onTouchEnd={(event) =>
            handleEdgeSwipeEnd(event.changedTouches[0]?.clientX ?? 0)
          }
        />
      ) : null}

      <div
        className={`fixed inset-0 z-40 transition-opacity ${
          isPreviewPanelOpen
            ? 'pointer-events-auto bg-black/45 opacity-100'
            : 'pointer-events-none opacity-0'
        }`}
      >
        <button
          type="button"
          className="absolute inset-0"
          onClick={() => setIsPreviewPanelOpen(false)}
          aria-label="Close app preview panel"
        />

        <aside
          className={`absolute right-0 top-0 h-full w-[min(92vw,560px)] border-l-2 border-foreground bg-background shadow-[-6px_0_0_var(--foreground)] transition-transform duration-300 ${
            isPreviewPanelOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          onTouchStart={(event) =>
            handlePanelSwipeStart(event.touches[0]?.clientX ?? 0)
          }
          onTouchEnd={(event) =>
            handlePanelSwipeEnd(event.changedTouches[0]?.clientX ?? 0)
          }
        >
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between border-b-2 border-foreground px-4 py-3">
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">
                  Live App Preview
                </p>
                <p className="mt-1 text-sm font-bold">
                  Swipe right or tap outside to close
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsPreviewPanelOpen(false)}
                className="border-2 border-foreground text-xs font-black uppercase"
              >
                Close
              </Button>
            </div>

            <div className="border-b-2 border-foreground bg-muted px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Preview Port
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {QUICK_PREVIEW_PORTS.map((port) => (
                  <button
                    key={port}
                    type="button"
                    onClick={() => setPreviewPort(port)}
                    className={`rounded-md border-2 px-2 py-1 text-xs font-black uppercase ${
                      previewPort === port
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-foreground bg-background'
                    }`}
                  >
                    {port}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Custom Port
              </label>
              <input
                value={previewPort}
                onChange={(event) => setPreviewPort(event.target.value)}
                inputMode="numeric"
                className="mt-1 w-full border-2 border-foreground bg-background px-3 py-2 text-sm font-bold"
                placeholder="5173"
              />
              {!isValidPreviewPort(previewPort) ? (
                <p className="mt-2 text-xs text-destructive">
                  Enter a valid port between 1 and 65535.
                </p>
              ) : null}

              <div className="mt-4 rounded-md border-2 border-foreground bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Preview action
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isX402SandboxPaymentMethod(paymentMethod)
                        ? `x402 only prompts when you explicitly request a boot.`
                        : `Opening this panel auto-boots the preview from your selected rail when needed.`}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      previewBootAttemptKeyRef.current = null
                      void triggerPreviewBoot()
                    }}
                    disabled={
                      isPreviewBooting || !isValidPreviewPort(previewPort)
                    }
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    {isPreviewBooting
                      ? isX402SandboxPaymentMethod(paymentMethod)
                        ? 'Waiting for wallet...'
                        : paymentMethod === 'delegated_budget'
                          ? 'Settling budget...'
                          : 'Booting...'
                      : isX402SandboxPaymentMethod(paymentMethod)
                        ? 'Pay and boot'
                        : paymentMethod === 'delegated_budget'
                          ? 'Use budget and boot'
                          : 'Retry boot'}
                  </Button>
                </div>
                {isPreviewBooting ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Starting the preview server on port {previewPort}...
                  </p>
                ) : null}
                {previewBootError ? (
                  <p className="mt-2 text-xs text-destructive">
                    {previewBootError}
                  </p>
                ) : null}
              </div>

              {showManualPreviewFallback ? (
                <div className="mt-4 rounded-md border-2 border-foreground bg-accent/15 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                        Preview taking longer than 10s
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Open the Daytona terminal and run the dev server
                        yourself.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleOpenWebTerminal}
                      disabled={isWebTerminalLoading}
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    {isWebTerminalLoading
                        ? isX402SandboxPaymentMethod(paymentMethod)
                          ? 'Waiting...'
                          : 'Opening...'
                        : 'Open Terminal'}
                    </Button>
                  </div>
                  {isPreviewCommandSuggestionLoading ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Preparing a suggested command...
                    </p>
                  ) : null}
                  {previewCommandSuggestion ? (
                    <div className="mt-2 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Suggested command for{' '}
                        {previewCommandSuggestion.packageManager}
                        {' / '}
                        {previewCommandSuggestion.framework}
                        {' / '}
                        {previewCommandSuggestion.previewScript}
                      </p>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-foreground/30 bg-background p-2 text-[11px]">
                        {previewCommandSuggestion.command}
                      </pre>
                    </div>
                  ) : null}
                  {previewCommandSuggestionError ? (
                    <p className="mt-2 text-xs text-destructive">
                      {previewCommandSuggestionError}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-4 rounded-md border-2 border-foreground bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Daytona Terminal
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleOpenWebTerminal}
                      disabled={isWebTerminalLoading}
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    {isWebTerminalLoading
                        ? isX402SandboxPaymentMethod(paymentMethod)
                          ? 'Waiting...'
                          : 'Opening...'
                        : 'Web Terminal'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCreateTerminalAccess}
                      disabled={isTerminalAccessLoading}
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    {isTerminalAccessLoading
                        ? isX402SandboxPaymentMethod(paymentMethod)
                          ? 'Waiting...'
                          : 'Creating...'
                        : 'Generate SSH'}
                    </Button>
                  </div>
                </div>
                {terminalAccessError ? (
                  <p className="mt-2 text-xs text-destructive">
                    {terminalAccessError}
                  </p>
                ) : null}
                {webTerminalError ? (
                  <p className="mt-2 text-xs text-destructive">
                    {webTerminalError}
                  </p>
                ) : null}
                {webTerminalUrl ? (
                  <a
                    href={webTerminalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs font-bold underline decoration-2 underline-offset-4"
                  >
                    Open current web terminal link →
                  </a>
                ) : null}
                {sshCommand ? (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {sshExpiresAt
                        ? `Expires at ${formatDateTime(sshExpiresAt) ?? sshExpiresAt}`
                        : 'Temporary SSH access created.'}
                    </p>
                    <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-foreground/30 bg-muted p-2 text-[11px]">
                      {sshCommand}
                    </pre>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Generate an SSH command to open a terminal directly in this
                    sandbox.
                  </p>
                )}
              </div>

              <div className="mt-4 rounded-md border-2 border-foreground bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    App Preview Logs
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setPreviewLogsRequestNonce((value) => value + 1)
                    }
                    disabled={isPreviewLogsLoading}
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    {isPreviewLogsLoading ? 'Loading...' : 'Refresh'}
                  </Button>
                </div>
                {previewLogPath ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {previewLogPath}
                  </p>
                ) : null}
                {previewLogsError ? (
                  <p className="mt-2 text-xs text-destructive">
                    {previewLogsError}
                  </p>
                ) : (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-foreground/30 bg-muted p-2 text-[11px]">
                    {previewLogs || 'No logs yet.'}
                  </pre>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 bg-card">
              {appPreviewUrl ? (
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-between border-b-2 border-foreground px-4 py-2">
                    <p className="truncate text-xs font-black uppercase tracking-widest">
                      Port {previewPort}
                    </p>
                    <a
                      href={appPreviewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-bold underline decoration-2 underline-offset-4"
                    >
                      New tab →
                    </a>
                  </div>
                  <iframe
                    title={`${sandbox.repoName} app preview on port ${previewPort}`}
                    src={appPreviewIframeUrl ?? appPreviewUrl}
                    onLoad={() => setHasPreviewIframeLoaded(true)}
                    className="h-full w-full bg-background"
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {previewUrlPattern
                      ? isX402SandboxPaymentMethod(paymentMethod)
                        ? 'Choose a port, then use Pay and boot to load the app preview with x402 if needed.'
                        : 'Choose a valid port to load your app preview.'
                      : 'App preview URL is not ready yet. Restarting the sandbox will populate the preview pattern for this panel.'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>

      <DeleteSandboxModal
        open={showDeleteModal}
        onOpenChange={setShowDeleteModal}
        onConfirm={handleDelete}
        sandboxName={sandbox.repoName}
      />
    </main>
  )
}
