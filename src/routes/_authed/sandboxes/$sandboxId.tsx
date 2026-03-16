import { useEffect, useMemo, useRef, useState } from 'react'
import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { api } from 'convex/_generated/api'
import type { Id } from 'convex/_generated/dataModel'
import { DeleteSandboxModal } from '~/components/delete-sandbox-modal'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { StatusPill } from '~/components/status-pill'
import { getSafeOpenCodeAgentPreset } from '~/lib/opencode/presets'
import {
  createTerminalAccess,
  deleteSandbox,
  getAppPreviewLogs,
  getPortPreview,
  ensureAppPreviewServer,
  restartSandbox,
} from '~/features/sandboxes/server'

const SWIPE_DISTANCE_PX = 60
const DEFAULT_APP_PREVIEW_PORT = '5173'
const QUICK_PREVIEW_PORTS = ['5173', '4173', '3001', '8080'] as const

function derivePreviewUrlPattern(previewUrl?: string, previewUrlPattern?: string) {
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

function formatDateTime(value?: string) {
  if (!value) {
    return null
  }

  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return value
  }

  return parsedDate.toLocaleString()
}

export const Route = createFileRoute('/_authed/sandboxes/$sandboxId')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      convexQuery(api.sandboxes.get, {
        sandboxId: params.sandboxId as Id<'sandboxes'>,
      }),
    )
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
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPreviewPanelOpen, setIsPreviewPanelOpen] = useState(false)
  const [previewPort, setPreviewPort] = useState(DEFAULT_APP_PREVIEW_PORT)
  const [isPreviewBooting, setIsPreviewBooting] = useState(false)
  const [previewBootError, setPreviewBootError] = useState<string | null>(null)
  const [previewIframeVersion, setPreviewIframeVersion] = useState(0)
  const [previewBootRequestNonce, setPreviewBootRequestNonce] = useState(0)
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null)
  const [previewLogs, setPreviewLogs] = useState<string>('')
  const [previewLogPath, setPreviewLogPath] = useState<string | null>(null)
  const [previewLogsError, setPreviewLogsError] = useState<string | null>(null)
  const [isPreviewLogsLoading, setIsPreviewLogsLoading] = useState(false)
  const [previewLogsRequestNonce, setPreviewLogsRequestNonce] = useState(0)
  const [sshCommand, setSshCommand] = useState<string | null>(null)
  const [sshExpiresAt, setSshExpiresAt] = useState<string | null>(null)
  const [terminalAccessError, setTerminalAccessError] = useState<string | null>(null)
  const [isTerminalAccessLoading, setIsTerminalAccessLoading] = useState(false)
  const [webTerminalError, setWebTerminalError] = useState<string | null>(null)
  const [isWebTerminalLoading, setIsWebTerminalLoading] = useState(false)
  const [webTerminalUrl, setWebTerminalUrl] = useState<string | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const edgeSwipeStartX = useRef<number | null>(null)
  const panelSwipeStartX = useRef<number | null>(null)
  const previewBootAttemptKeyRef = useRef<string | null>(null)

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
    ])
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

    try {
      const restarted = await restartSandbox({
        data: { sandboxId: sandbox._id },
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

  if (!sandbox) {
    return (
      <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
        <CardHeader>
          <CardTitle className="text-2xl font-black uppercase">
            Workspace missing
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            This sandbox no longer exists or you don't have access.
          </p>
        </CardHeader>
        <CardContent>
          <Button
            asChild
            className="border-2 border-foreground bg-foreground font-black uppercase text-background shadow-[3px_3px_0_var(--accent)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
          >
            <Link to="/dashboard">
              ← Back to dashboard
            </Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const sandboxId = sandbox._id
  const preset = getSafeOpenCodeAgentPreset(sandbox.agentPresetId)
  const presetLabel = sandbox.agentLabel ?? preset.label
  const previewUrlPattern = derivePreviewUrlPattern(
    sandbox.previewUrl,
    sandbox.previewUrlPattern,
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

  useEffect(() => {
    setActivePreviewUrl(null)
  }, [previewPort, sandboxId])

  useEffect(() => {
    if (!isPreviewPanelOpen) {
      setIsPreviewBooting(false)
      setPreviewBootError(null)
      setPreviewLogsError(null)
      previewBootAttemptKeyRef.current = null
      return
    }

    if (sandbox.status !== 'ready' || !isValidPreviewPort(previewPort)) {
      return
    }

    const port = Number(previewPort)
    const attemptKey = `${sandboxId}:${port}:${previewBootRequestNonce}`

    if (previewBootAttemptKeyRef.current === attemptKey) {
      return
    }

    previewBootAttemptKeyRef.current = attemptKey
    setIsPreviewBooting(true)
    setPreviewBootError(null)
    setActivePreviewUrl(null)

    void ensureAppPreviewServer({
      data: {
        sandboxId,
        port,
      },
    })
      .then((result) => {
        setActivePreviewUrl(result.previewUrl ?? null)
        setPreviewIframeVersion((value) => value + 1)
      })
      .catch((bootError) => {
        previewBootAttemptKeyRef.current = null
        setActivePreviewUrl(null)
        setPreviewBootError(
          bootError instanceof Error
            ? bootError.message
            : 'Could not start the app preview server.',
        )
      })
      .finally(() => {
        setIsPreviewBooting(false)
        setPreviewLogsRequestNonce((value) => value + 1)
      })
  }, [isPreviewPanelOpen, previewBootRequestNonce, previewPort, sandbox, sandboxId])

  useEffect(() => {
    if (!isPreviewPanelOpen || !isValidPreviewPort(previewPort)) {
      return
    }

    const port = Number(previewPort)
    setIsPreviewLogsLoading(true)
    setPreviewLogsError(null)

    void getAppPreviewLogs({
      data: {
        sandboxId,
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
  }, [isPreviewPanelOpen, previewLogsRequestNonce, previewPort, sandboxId])

  async function handleCreateTerminalAccess() {
    setIsTerminalAccessLoading(true)
    setTerminalAccessError(null)

    try {
      const access = await createTerminalAccess({
        data: {
          sandboxId,
          expiresInMinutes: 60,
        },
      })
      setSshCommand(access.sshCommand)
      setSshExpiresAt(String(access.expiresAt))
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
    setIsWebTerminalLoading(true)
    setWebTerminalError(null)

    try {
      const preview = await getPortPreview({
        data: {
          sandboxId,
          port: 22222,
        },
      })

      setWebTerminalUrl(preview.previewUrl)
      window.open(preview.previewUrl, '_blank', 'noopener,noreferrer')
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
                <Badge variant="outline" className="border-2 border-foreground font-bold uppercase tracking-widest">
                  {presetLabel}
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
            <Alert variant="destructive" className="mb-4 border-2 border-foreground">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <div className="border-2 border-foreground bg-muted p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Branch
              </p>
              <p className="mt-2 font-bold">{sandbox.repoBranch || 'default'}</p>
            </div>
            <div className="border-2 border-foreground bg-muted p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Preset
              </p>
              <p className="mt-2 font-bold">{presetLabel}</p>
            </div>
            <div className="border-2 border-foreground bg-muted p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Workspace
              </p>
              <p className="mt-2 break-all font-bold">
                {sandbox.workspacePath || 'Provisioning...'}
              </p>
            </div>
            <div className="border-2 border-foreground bg-muted p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Preview
              </p>
              {sandbox.previewUrl ? (
                <a
                  href={sandbox.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block font-bold text-accent-foreground underline decoration-2 underline-offset-4 hover:text-foreground"
                >
                  Open in new tab →
                </a>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Waiting for OpenCode...
                </p>
              )}
            </div>
          </div>

          {sandbox.initialPrompt ? (
            <div className="mt-4 border-2 border-dashed border-foreground bg-muted p-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                Kickoff Prompt
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                {sandbox.initialPrompt}
              </p>
            </div>
          ) : null}
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
              {isPreviewBooting ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Starting the preview server on port {previewPort}...
                </p>
              ) : null}
              {previewBootError ? (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-destructive">{previewBootError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPreviewBootRequestNonce((value) => value + 1)}
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    Retry
                  </Button>
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
                      {isWebTerminalLoading ? 'Opening...' : 'Web Terminal'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCreateTerminalAccess}
                      disabled={isTerminalAccessLoading}
                      className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                    >
                      {isTerminalAccessLoading ? 'Creating...' : 'Generate SSH'}
                    </Button>
                  </div>
                </div>
                {terminalAccessError ? (
                  <p className="mt-2 text-xs text-destructive">{terminalAccessError}</p>
                ) : null}
                {webTerminalError ? (
                  <p className="mt-2 text-xs text-destructive">{webTerminalError}</p>
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
                    Generate an SSH command to open a terminal directly in this sandbox.
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
                    onClick={() => setPreviewLogsRequestNonce((value) => value + 1)}
                    disabled={isPreviewLogsLoading}
                    className="h-7 border-2 border-foreground px-2 text-[10px] font-black uppercase"
                  >
                    {isPreviewLogsLoading ? 'Loading...' : 'Refresh'}
                  </Button>
                </div>
                {previewLogPath ? (
                  <p className="mt-2 text-xs text-muted-foreground">{previewLogPath}</p>
                ) : null}
                {previewLogsError ? (
                  <p className="mt-2 text-xs text-destructive">{previewLogsError}</p>
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
                    className="h-full w-full bg-background"
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {previewUrlPattern
                      ? 'Choose a valid port to load your app preview.'
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
