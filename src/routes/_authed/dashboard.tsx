import { useState } from 'react'
import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { api } from 'convex/_generated/api'
import type { ChangeEvent, FormEvent } from 'react'
import type { GithubRepoOption } from '~/features/sandboxes/server'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { DeleteSandboxModal } from '~/components/delete-sandbox-modal'
import { SandboxCard } from '~/components/sandbox-card'
import {
  checkGithubConnection,
  createSandbox,
  deleteSandbox,
  listGithubBranches,
  listGithubRepos,
  restartSandbox,
} from '~/features/sandboxes/server'
import type { OpenCodeAgentPresetId } from '~/lib/opencode/presets'
import { getOpenCodeAgentPreset, openCodeAgentPresets } from '~/lib/opencode/presets'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/_authed/dashboard')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(convexQuery(api.user.current, {})),
      context.queryClient.ensureQueryData(convexQuery(api.sandboxes.list, {})),
    ])

    const github = await checkGithubConnection()

    return {
      github,
    }
  },
  component: DashboardRoute,
})

function DashboardRoute() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { github } = Route.useLoaderData()
  const { data: user } = useSuspenseQuery(convexQuery(api.user.current, {}))
  const { data: sandboxes } = useSuspenseQuery(convexQuery(api.sandboxes.list, {}))
  const [agentPresetId, setAgentPresetId] =
    useState<OpenCodeAgentPresetId>('general-engineer')
  const [initialPrompt, setInitialPrompt] = useState('')
  const githubReposQueryKey = ['github', 'recent-repos', user?._id ?? 'anonymous'] as const
  const githubReposQuery = useQuery({
    queryKey: githubReposQueryKey,
    queryFn: () => listGithubRepos(),
    enabled: github.connected,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [busySandboxId, setBusySandboxId] = useState<string | null>(null)
  const [githubBranches, setGithubBranches] = useState<Array<string>>([])
  const [githubPickerError, setGithubPickerError] = useState<string | null>(null)
  const [isLoadingGithubBranches, setIsLoadingGithubBranches] = useState(false)
  const [selectedGithubRepoFullName, setSelectedGithubRepoFullName] = useState<
    string | null
  >(null)
  const [deleteModalSandboxId, setDeleteModalSandboxId] = useState<string | null>(
    null,
  )
  const githubRepos = githubReposQuery.data ?? []
  const githubReposError =
    githubReposQuery.error instanceof Error ? githubReposQuery.error.message : null
  const isLoadingGithubRepos = githubReposQuery.isPending && githubRepos.length === 0
  const isRefreshingGithubRepos = githubReposQuery.isFetching
  const githubAlertMessage = githubPickerError ?? githubReposError
  const selectedPreset = getOpenCodeAgentPreset(agentPresetId)

  async function refreshDashboard() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.user.current, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.sandboxes.list, {}).queryKey,
      }),
    ])
  }

  async function loadGithubBranchesForRepo(repo: GithubRepoOption) {
    setSelectedGithubRepoFullName(repo.fullName)
    setIsLoadingGithubBranches(true)
    setGithubPickerError(null)

    try {
      const branches = await listGithubBranches({
        data: {
          repoFullName: repo.fullName,
        },
      })

      setGithubBranches(branches)
    } catch (error) {
      setGithubBranches([])
      setGithubPickerError(
        error instanceof Error ? error.message : 'Could not load GitHub branches.',
      )
    } finally {
      setIsLoadingGithubBranches(false)
    }
  }

  function applyGithubRepo(repo: GithubRepoOption) {
    setRepoUrl(repo.cloneUrl)
    setBranch(repo.defaultBranch)
    void loadGithubBranchesForRepo(repo)
  }

  async function handleRefreshGithubRepos() {
    setGithubPickerError(null)

    const { data: repos = [] } = await githubReposQuery.refetch()
    const matchedRepo = repos.find((repo) => repo.cloneUrl === repoUrl)

    if (matchedRepo) {
      setBranch((currentBranch) => currentBranch || matchedRepo.defaultBranch)
      void loadGithubBranchesForRepo(matchedRepo)
    }
  }

  function handleRepoUrlChange(event: ChangeEvent<HTMLInputElement>) {
    const nextRepoUrl = event.target.value
    const matchedRepo = githubRepos.find((repo) => repo.cloneUrl === nextRepoUrl)

    setFormError(null)
    setGithubPickerError(null)
    setRepoUrl(nextRepoUrl)

    if (!matchedRepo) {
      setSelectedGithubRepoFullName(null)
      setGithubBranches([])
      return
    }

    applyGithubRepo(matchedRepo)
  }

  async function handleCreateSandbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setActionError(null)
    setIsCreating(true)

    try {
      const result = await createSandbox({
        data: {
          agentPresetId,
          initialPrompt,
          repoUrl,
          branch,
        },
      })

      setRepoUrl('')
      setBranch('')
      setInitialPrompt('')
      setSelectedGithubRepoFullName(null)
      setGithubBranches([])
      await refreshDashboard()
      await navigate({
        to: '/sandboxes/$sandboxId',
        params: { sandboxId: result.sandboxId },
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Sandbox creation failed.')
    } finally {
      setIsCreating(false)
    }
  }

  async function handleDeleteSandbox(sandboxId: string) {
    setBusySandboxId(sandboxId)
    setActionError(null)

    try {
      await deleteSandbox({
        data: { sandboxId },
      })
      await refreshDashboard()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Sandbox deletion failed.')
    } finally {
      setBusySandboxId(null)
    }
  }

  async function handleRestartSandbox(sandboxId: string) {
    setBusySandboxId(sandboxId)
    setActionError(null)

    try {
      const result = await restartSandbox({
        data: { sandboxId },
      })
      await refreshDashboard()
      await navigate({
        to: '/sandboxes/$sandboxId',
        params: { sandboxId: result.sandboxId },
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Sandbox restart failed.')
    } finally {
      setBusySandboxId(null)
    }
  }

  const userLabel = user?.name ?? user?.email ?? 'builder'

  return (
    <main className="flex flex-col gap-8">
      <section>
        <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
          <CardHeader>
            <CardTitle className="text-3xl font-black uppercase sm:text-4xl">
              Welcome, {userLabel}.
            </CardTitle>
          </CardHeader>

          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleCreateSandbox}>
              <div className="flex flex-col gap-3">
                <div
                  role="radiogroup"
                  aria-label="OpenCode preset agent"
                  className="grid gap-3 md:grid-cols-3"
                >
                  {openCodeAgentPresets.map((preset) => {
                    const isSelected = preset.id === agentPresetId

                    return (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => {
                          setFormError(null)
                          setAgentPresetId(preset.id)
                        }}
                        className={cn(
                          'flex flex-col gap-3 rounded-lg border-2 border-foreground p-4 text-left shadow-[3px_3px_0_var(--foreground)] transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                          isSelected
                            ? 'translate-x-[2px] translate-y-[2px] bg-accent shadow-none'
                            : 'bg-background hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-black uppercase tracking-wide">
                              {preset.label}
                            </p>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {preset.description}
                            </p>
                          </div>
                          <Badge
                            variant={isSelected ? 'secondary' : 'outline'}
                            className="border-2 border-foreground font-bold uppercase tracking-widest"
                          >
                            {isSelected ? 'Selected' : 'Preset'}
                          </Badge>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="repo-url"
                  className="text-[10px] font-black uppercase tracking-widest"
                >
                  Repository URL
                </label>
                <Input
                  id="repo-url"
                  type="url"
                  required
                  list={githubRepos.length > 0 ? 'github-repo-options' : undefined}
                  value={repoUrl}
                  onChange={handleRepoUrlChange}
                  placeholder="https://github.com/owner/repo.git"
                  className="border-2 border-foreground bg-background font-mono text-sm shadow-[2px_2px_0_var(--foreground)] focus-visible:shadow-none"
                />

                {github.connected ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void handleRefreshGithubRepos()
                      }}
                      disabled={isRefreshingGithubRepos}
                      className="border-2 border-foreground text-xs font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
                    >
                      {isLoadingGithubRepos
                        ? 'Fetching latest repos...'
                        : isRefreshingGithubRepos
                          ? 'Refreshing...'
                          : 'Refresh repos'}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {isLoadingGithubRepos
                        ? 'Loading your latest 10 repos.'
                        : githubRepos.length > 0
                          ? `${githubRepos.length} recent repo${githubRepos.length === 1 ? '' : 's'} cached until refresh.`
                          : 'No recent GitHub repos found.'}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Connect GitHub in Clerk to browse repos.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="branch"
                  className="text-[10px] font-black uppercase tracking-widest"
                >
                  Branch
                </label>
                <Input
                  id="branch"
                  type="text"
                  list={githubBranches.length > 0 ? 'github-branch-options' : undefined}
                  value={branch}
                  onChange={(event) => {
                    setFormError(null)
                    setBranch(event.target.value)
                  }}
                  placeholder="main"
                  className="border-2 border-foreground bg-background font-mono text-sm shadow-[2px_2px_0_var(--foreground)] focus-visible:shadow-none"
                />
                <p className="text-xs text-muted-foreground">
                  {isLoadingGithubBranches
                    ? 'Fetching branches...'
                    : selectedGithubRepoFullName && githubBranches.length > 0
                      ? `${githubBranches.length} branch${githubBranches.length === 1 ? '' : 'es'} from ${selectedGithubRepoFullName}.`
                      : 'Leave blank for default branch.'}
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <label
                  htmlFor="kickoff-prompt"
                  className="text-[10px] font-black uppercase tracking-widest"
                >
                  Kickoff Prompt
                </label>
                <Textarea
                  id="kickoff-prompt"
                  value={initialPrompt}
                  onChange={(event) => {
                    setFormError(null)
                    setInitialPrompt(event.target.value)
                  }}
                  placeholder={selectedPreset.starterPromptPlaceholder}
                  className="min-h-28 border-2 border-foreground bg-background font-mono text-sm shadow-[2px_2px_0_var(--foreground)] focus-visible:shadow-none"
                />
                <p className="text-xs text-muted-foreground">
                  Leave this blank to use the preset&apos;s built-in kickoff
                  prompt.
                </p>
              </div>

              {githubRepos.length > 0 ? (
                <datalist id="github-repo-options">
                  {githubRepos.map((repo) => (
                    <option
                      key={repo.id}
                      value={repo.cloneUrl}
                      label={`${repo.fullName} (${repo.private ? 'private' : 'public'})`}
                    />
                  ))}
                </datalist>
              ) : null}

              {githubBranches.length > 0 ? (
                <datalist id="github-branch-options">
                  {githubBranches.map((branchName) => (
                    <option key={branchName} value={branchName} />
                  ))}
                </datalist>
              ) : null}

              {githubAlertMessage ? (
                <Alert variant="destructive" className="border-2 border-foreground">
                  <AlertDescription>{githubAlertMessage}</AlertDescription>
                </Alert>
              ) : null}

              {formError ? (
                <Alert variant="destructive" className="border-2 border-foreground">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  disabled={isCreating}
                  className="h-10 border-2 border-foreground bg-foreground px-6 text-sm font-black uppercase tracking-wider text-background shadow-[4px_4px_0_var(--accent)] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
                >
                  {isCreating ? 'Launching...' : 'Create sandbox →'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Workspaces
            </p>
            <h3 className="mt-1 text-2xl font-black uppercase">
              Pie's Workspaces
            </h3>
          </div>
          <p className="border-2 border-foreground bg-accent px-2 py-1 text-xs font-black">
            {sandboxes.length}
          </p>
        </div>

        {actionError ? (
          <Alert variant="destructive" className="border-2 border-foreground">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        {sandboxes.length === 0 ? (
          <div className="border-2 border-dashed border-foreground bg-muted p-10 text-center text-sm font-bold text-muted-foreground">
            Your first sandbox will appear here.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {sandboxes.map((sandbox) => (
              <SandboxCard
                key={sandbox._id}
                sandbox={sandbox}
                isBusy={busySandboxId === sandbox._id}
                onDelete={() => setDeleteModalSandboxId(sandbox._id)}
                onRestart={() => handleRestartSandbox(sandbox._id)}
              />
            ))}
          </div>
        )}

        <DeleteSandboxModal
          open={deleteModalSandboxId !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteModalSandboxId(null)
          }}
          onConfirm={async () => {
            if (deleteModalSandboxId) {
              await handleDeleteSandbox(deleteModalSandboxId)
            }
          }}
          sandboxName={
            deleteModalSandboxId
              ? sandboxes.find((s) => s._id === deleteModalSandboxId)?.repoName
              : undefined
          }
        />
      </section>
    </main>
  )
}
