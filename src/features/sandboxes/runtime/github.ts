import { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'

type GithubApiRepo = {
  id: number
  full_name: string
  clone_url: string
  default_branch: string
  private: boolean
}

type GithubApiBranch = {
  name: string
}

export type GithubLaunchAuth = {
  token: string
  scopes: Array<string>
  accountLogin?: string
  accountName?: string
  accountEmail?: string
}

function normalizeGithubScopes(scopes?: Array<string> | string | null) {
  const rawScopes = Array.isArray(scopes)
    ? scopes
    : typeof scopes === 'string'
      ? scopes.split(/[,\s]+/)
      : []

  return Array.from(
    new Set(
      rawScopes
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right))
}

function isGithubAccountProvider(provider?: string | null) {
  return provider === 'github' || provider === 'oauth_github'
}

export async function getGithubLaunchAuth(
  userId: string,
): Promise<GithubLaunchAuth | null> {
  const { clerkClient } = await import('@clerk/tanstack-react-start/server')
  const client = await clerkClient()
  const [tokens, clerkUser] = await Promise.all([
    client.users.getUserOauthAccessToken(userId, 'github'),
    client.users.getUser(userId),
  ])
  const accessToken = tokens.data[0]
  const externalAccounts = clerkUser.externalAccounts ?? []
  const githubAccount =
    externalAccounts.find(
      (account) =>
        account.id === accessToken?.externalAccountId &&
        isGithubAccountProvider(account.provider),
    ) ??
    externalAccounts.find((account) =>
      isGithubAccountProvider(account.provider),
    ) ??
    null

  if (!accessToken?.token) {
    return null
  }

  const accountName =
    [githubAccount?.firstName, githubAccount?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    githubAccount?.username ||
    clerkUser.fullName ||
    clerkUser.username ||
    undefined
  const accountEmail =
    githubAccount?.emailAddress ||
    clerkUser.primaryEmailAddress?.emailAddress ||
    undefined

  return {
    token: accessToken.token,
    scopes: normalizeGithubScopes([
      ...normalizeGithubScopes(accessToken.scopes),
      ...normalizeGithubScopes(githubAccount?.approvedScopes),
    ]),
    ...(githubAccount?.username
      ? { accountLogin: githubAccount.username }
      : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  }
}

export function hasGithubRepoScope(scopes: Array<string>) {
  return scopes.includes('repo')
}

function buildGithubConnectionMessage(auth: GithubLaunchAuth | null) {
  if (!auth?.token) {
    return 'Connect GitHub from your Clerk profile to import private repositories and let the agent push PRs.'
  }

  const accountLabel = auth.accountLogin
    ? `@${auth.accountLogin}`
    : 'your GitHub account'

  if (!hasGithubRepoScope(auth.scopes)) {
    return `${accountLabel} is connected in Clerk, but the GitHub repo scope is missing. Reconnect GitHub from your Clerk profile and approve repo access before asking the agent to push branches or PRs.`
  }

  return `${accountLabel} is connected with repo scope and ready for private repository imports and PR pushes.`
}

export async function getRequiredGithubLaunchAuth(userId: string) {
  const githubAuth = await getGithubLaunchAuth(userId)

  if (!githubAuth?.token) {
    throw new Error('Connect GitHub in Clerk before fetching repositories.')
  }

  if (!hasGithubRepoScope(githubAuth.scopes)) {
    throw new Error(
      'GitHub is connected, but repo scope is missing. Reconnect GitHub in Clerk and approve repo access before continuing.',
    )
  }

  return githubAuth
}

async function githubRequest<T>(githubToken: string, path: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (response.ok) {
    return (await response.json()) as T
  }

  let githubMessage = 'GitHub could not complete that request.'

  try {
    const error = (await response.json()) as { message?: string }

    if (error.message) {
      githubMessage = error.message
    }
  } catch {
    // Fall back to the generic message when GitHub returns a non-JSON body.
  }

  if (response.status === 401) {
    throw new Error(
      'Your GitHub access expired. Refresh the GitHub connection in Clerk and try again.',
    )
  }

  if (response.status === 403) {
    throw new Error(
      'GitHub denied access. Refresh the GitHub connection in Clerk and make sure repo access is granted.',
    )
  }

  throw new Error(githubMessage)
}

async function fetchGithubRepos(githubToken: string) {
  return githubRequest<Array<GithubApiRepo>>(
    githubToken,
    '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=10',
  )
}

export async function checkGithubConnectionRuntime() {
  const { userId } = await getAuthenticatedConvexClient()
  const githubAuth = await getGithubLaunchAuth(userId)

  return {
    connected: githubAuth ? hasGithubRepoScope(githubAuth.scopes) : false,
    accountLogin: githubAuth?.accountLogin ?? null,
    scopes: githubAuth?.scopes ?? [],
    message: buildGithubConnectionMessage(githubAuth),
  }
}

export async function listGithubReposRuntime() {
  const { userId } = await getAuthenticatedConvexClient()
  const githubAuth = await getRequiredGithubLaunchAuth(userId)
  const repos = await fetchGithubRepos(githubAuth.token)

  return repos.map((repo) => ({
    id: repo.id,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
    private: repo.private,
  }))
}

export async function listGithubBranchesRuntime(repoFullName: string) {
  const normalizedRepoFullName = repoFullName.trim()
  const [owner, repo, ...rest] = normalizedRepoFullName.split('/')

  if (!owner || !repo || rest.length > 0) {
    throw new Error(
      'Choose a valid GitHub repository before fetching branches.',
    )
  }

  const { userId } = await getAuthenticatedConvexClient()
  const githubAuth = await getRequiredGithubLaunchAuth(userId)
  const branches = await githubRequest<Array<GithubApiBranch>>(
    githubAuth.token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
  )

  return branches.map((branch) => branch.name)
}
