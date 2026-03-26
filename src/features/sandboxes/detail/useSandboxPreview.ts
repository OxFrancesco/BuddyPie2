import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureAppPreviewServer,
  getAppPreviewCommandSuggestion,
  getAppPreviewLogs,
} from '~/features/sandboxes/server'
import { postJsonWithX402Payment } from '~/lib/billing/x402-client'
import {
  isX402SandboxPaymentMethod,
  type SandboxPaymentMethod,
} from '~/lib/sandboxes'
import type {
  PreviewBootResult,
  PreviewCommandSuggestionResult,
  PreviewLogResult,
  SandboxDetailRecord,
  UtilityDrawerTab,
} from './types'
import {
  DEFAULT_APP_PREVIEW_PORT,
  derivePreviewUrlPattern,
  isValidPreviewPort,
  PREVIEW_TERMINAL_FALLBACK_DELAY_MS,
} from './utils'

type DelegatedBudgetHealthLike =
  | {
      message?: string | null
    }
  | null
  | undefined

export function useSandboxPreview(args: {
  sandbox: SandboxDetailRecord | null | undefined
  paymentMethod: SandboxPaymentMethod
  hasActiveDelegatedBudget: boolean
  delegatedBudgetHealth: DelegatedBudgetHealthLike
  x402ChainId: number
  isPreviewPanelOpen: boolean
  utilityDrawerTab: UtilityDrawerTab
  refreshSandboxQueries: () => Promise<void>
}) {
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
  const [resolvedPreviewAppPath, setResolvedPreviewAppPath] = useState<
    string | null
  >(null)
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
  const previewBootAttemptKeyRef = useRef<string | null>(null)

  const previewUrlPattern = derivePreviewUrlPattern(
    args.sandbox?.previewUrl,
    args.sandbox?.previewUrlPattern,
  )
  const effectivePreviewAppPath =
    resolvedPreviewAppPath ??
    args.sandbox?.previewAppPath ??
    args.sandbox?.workspacePath ??
    null
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

  async function triggerPreviewBoot() {
    if (!args.sandbox || !isValidPreviewPort(previewPort)) {
      return
    }

    if (
      args.paymentMethod === 'delegated_budget' &&
      !args.hasActiveDelegatedBudget
    ) {
      previewBootAttemptKeyRef.current = null
      setPreviewBootError(
        args.delegatedBudgetHealth?.message ??
          'Set up an active delegated budget before using that payment rail.',
      )
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
      const result = isX402SandboxPaymentMethod(args.paymentMethod)
        ? await postJsonWithX402Payment<PreviewBootResult>({
            url: `/api/x402/sandboxes/${args.sandbox._id}/preview`,
            body: { port },
            chainId: args.x402ChainId,
          })
        : await ensureAppPreviewServer({
            data: {
              sandboxId: args.sandbox._id,
              port,
              paymentMethod: args.paymentMethod,
            } as any,
          })

      setActivePreviewUrl(result.previewUrl ?? null)
      setResolvedPreviewAppPath(result.previewAppPath ?? null)
      setPreviewIframeVersion((value) => value + 1)
      await args.refreshSandboxQueries()
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

  useEffect(() => {
    setActivePreviewUrl(null)
    setResolvedPreviewAppPath(null)
    previewBootAttemptKeyRef.current = null
    setPreviewBootStartedAt(null)
    setShowManualPreviewFallback(false)
    setHasPreviewIframeLoaded(false)
    setPreviewCommandSuggestion(null)
    setPreviewCommandSuggestionError(null)
  }, [previewPort, args.sandbox?._id, args.paymentMethod])

  useEffect(() => {
    if (!args.isPreviewPanelOpen) {
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
      args.utilityDrawerTab !== 'preview' ||
      !args.sandbox ||
      args.sandbox.status !== 'ready' ||
      !isValidPreviewPort(previewPort)
    ) {
      return
    }

    if (isX402SandboxPaymentMethod(args.paymentMethod)) {
      return
    }

    const port = Number(previewPort)
    const attemptKey = `${args.sandbox._id}:${port}:${args.paymentMethod}`

    if (previewBootAttemptKeyRef.current === attemptKey) {
      return
    }

    previewBootAttemptKeyRef.current = attemptKey
    void triggerPreviewBoot()
  }, [
    args.isPreviewPanelOpen,
    args.paymentMethod,
    previewPort,
    args.sandbox,
    args.utilityDrawerTab,
  ])

  useEffect(() => {
    if (
      args.utilityDrawerTab !== 'preview' ||
      !args.isPreviewPanelOpen ||
      !args.sandbox ||
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
    args.isPreviewPanelOpen,
    previewBootStartedAt,
    previewPort,
    args.sandbox,
    args.utilityDrawerTab,
  ])

  useEffect(() => {
    if (
      !showManualPreviewFallback ||
      !args.sandbox ||
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
        sandboxId: args.sandbox._id,
        port,
      },
    })
      .then((result) => {
        setPreviewCommandSuggestion(result)
        setResolvedPreviewAppPath(result.previewAppPath ?? null)
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
    args.sandbox,
    showManualPreviewFallback,
  ])

  useEffect(() => {
    if (hasPreviewIframeLoaded) {
      setShowManualPreviewFallback(false)
    }
  }, [hasPreviewIframeLoaded])

  useEffect(() => {
    if (
      args.utilityDrawerTab !== 'preview' ||
      !args.isPreviewPanelOpen ||
      !args.sandbox ||
      !isValidPreviewPort(previewPort)
    ) {
      return
    }

    const port = Number(previewPort)
    setIsPreviewLogsLoading(true)
    setPreviewLogsError(null)

    void getAppPreviewLogs({
      data: {
        sandboxId: args.sandbox._id,
        port,
      },
    })
      .then((result: PreviewLogResult) => {
        setPreviewLogs(result.output || 'No logs yet.')
        setPreviewLogPath(result.logPath)
        setResolvedPreviewAppPath(result.previewAppPath ?? null)
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
  }, [
    args.isPreviewPanelOpen,
    previewLogsRequestNonce,
    previewPort,
    args.sandbox,
    args.utilityDrawerTab,
  ])

  return {
    previewPort,
    setPreviewPort,
    isPreviewBooting,
    previewBootError,
    previewLogs,
    previewLogPath,
    previewLogsError,
    isPreviewLogsLoading,
    previewLogsRequestNonce,
    setPreviewLogsRequestNonce,
    effectivePreviewAppPath,
    showManualPreviewFallback,
    hasPreviewIframeLoaded,
    setHasPreviewIframeLoaded,
    previewCommandSuggestion,
    previewCommandSuggestionError,
    isPreviewCommandSuggestionLoading,
    appPreviewUrl,
    appPreviewIframeUrl,
    retryPreviewBoot: async () => {
      previewBootAttemptKeyRef.current = null
      await triggerPreviewBoot()
    },
  }
}
