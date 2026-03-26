import { api } from 'convex/_generated/api'
import type { Doc, Id } from 'convex/_generated/dataModel'
import type { getAuthenticatedConvexClient } from '~/lib/server/authenticated-convex'
import { Context, Effect, Layer } from 'effect'
import {
  assertDelegatedBudgetAllowanceOrThrow,
  settleDelegatedBudgetOnchain,
} from '~/lib/server/delegated-budget'
import {
  createOpenCodeSandbox,
  createSandboxSshAccessCommand,
  deleteOpenCodeSandbox,
  ensureSandboxAppPreviewServer,
  getSandboxAppPreviewCommandSuggestion,
  getSandboxAppPreviewLogTail,
  getSandboxAppPreviewStatus,
  getSandboxPortPreviewUrl,
  readSandboxCurrentArtifact,
  resolveOpenCodeLaunchConfig,
  sendPromptToSandboxOpencodeSession,
  type GitHubLaunchAuth,
} from '~/lib/server/daytona'
import { requireX402Payment } from '~/lib/server/x402'
import {
  AuthError,
  ConfigError,
  ExternalServiceError,
  PaymentError,
  SandboxError,
} from './errors'
import {
  getBillingEventPriceUsdCents,
  type BillingEventType,
} from '../../../../convex/lib/billingConfig'

export type AuthenticatedServerContext = Awaited<
  ReturnType<typeof getAuthenticatedConvexClient>
>

function stripTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveConvexHttpUrl(convexUrl: string, configuredSiteUrl?: string) {
  if (configuredSiteUrl) {
    return stripTrailingSlash(configuredSiteUrl)
  }

  return stripTrailingSlash(convexUrl).replace(/\.cloud(?=\/|$)/, '.site')
}

function normalizeUnknownMessage(
  error: unknown,
  fallback: string,
) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

export interface EnvService {
  get(name: string): string | undefined
  require(name: string): Effect.Effect<string, ConfigError>
  resolveConvexHttpUrl(convexUrl: string): string
}

export const EnvService = Context.GenericTag<EnvService>('buddyPie/EnvService')

export interface AuthService {
  context: AuthenticatedServerContext
}

export const AuthService = Context.GenericTag<AuthService>('buddyPie/AuthService')

export interface ConvexService {
  context: AuthenticatedServerContext
  ensureCurrentUser: Effect.Effect<void, ExternalServiceError>
  getOwnedSandbox: (
    sandboxId: string,
  ) => Effect.Effect<Doc<'sandboxes'>, SandboxError | ExternalServiceError>
}

export const ConvexService =
  Context.GenericTag<ConvexService>('buddyPie/ConvexService')

export interface DaytonaService {
  createOpenCodeSandbox: (
    args: Parameters<typeof createOpenCodeSandbox>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof createOpenCodeSandbox>>,
    SandboxError
  >
  deleteOpenCodeSandbox: (
    daytonaSandboxId: string,
  ) => Effect.Effect<void, SandboxError>
  resolveOpenCodeLaunchConfig: (
    args: {
      agentPresetId: string
      agentProvider?: string
      agentModel?: string
      githubAuth?: GitHubLaunchAuth | null
    },
  ) => Effect.Effect<
    Awaited<ReturnType<typeof resolveOpenCodeLaunchConfig>>,
    ConfigError
  >
  ensureSandboxAppPreviewServer: (
    args: Parameters<typeof ensureSandboxAppPreviewServer>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof ensureSandboxAppPreviewServer>>,
    SandboxError
  >
  getSandboxAppPreviewStatus: (
    args: Parameters<typeof getSandboxAppPreviewStatus>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof getSandboxAppPreviewStatus>>,
    SandboxError
  >
  getSandboxAppPreviewLogTail: (
    args: Parameters<typeof getSandboxAppPreviewLogTail>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof getSandboxAppPreviewLogTail>>,
    SandboxError
  >
  getSandboxAppPreviewCommandSuggestion: (
    args: Parameters<typeof getSandboxAppPreviewCommandSuggestion>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof getSandboxAppPreviewCommandSuggestion>>,
    SandboxError
  >
  readSandboxCurrentArtifact: (
    args: Parameters<typeof readSandboxCurrentArtifact>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof readSandboxCurrentArtifact>>,
    SandboxError
  >
  createSandboxSshAccessCommand: (
    args: Parameters<typeof createSandboxSshAccessCommand>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof createSandboxSshAccessCommand>>,
    SandboxError
  >
  getSandboxPortPreviewUrl: (
    args: Parameters<typeof getSandboxPortPreviewUrl>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof getSandboxPortPreviewUrl>>,
    SandboxError
  >
  sendPromptToSandboxOpencodeSession: (
    args: Parameters<typeof sendPromptToSandboxOpencodeSession>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof sendPromptToSandboxOpencodeSession>>,
    SandboxError
  >
}

export const DaytonaService =
  Context.GenericTag<DaytonaService>('buddyPie/DaytonaService')

export interface BillingService {
  priceForEvent: (agentPresetId: string, eventType: BillingEventType) => number
  requireDelegatedBudgetAllowance: (args: {
    requiredAmountUsdCents: number
    actionLabel: string
  }) => Effect.Effect<
    Doc<'delegatedBudgets'>,
    PaymentError | ExternalServiceError
  >
  settleDelegatedBudgetOnchain: (
    args: Parameters<typeof settleDelegatedBudgetOnchain>[0],
  ) => Effect.Effect<
    Awaited<ReturnType<typeof settleDelegatedBudgetOnchain>>,
    PaymentError | ExternalServiceError
  >
}

export const BillingService =
  Context.GenericTag<BillingService>('buddyPie/BillingService')

type X402Payment = Awaited<ReturnType<typeof requireX402Payment>>
type SuccessfulX402Payment = Extract<X402Payment, { ok: true }>

export interface X402Service {
  requirePayment: (
    args: Parameters<typeof requireX402Payment>[0],
  ) => Effect.Effect<X402Payment, ConfigError | ExternalServiceError>
  settlePayment: (
    payment: SuccessfulX402Payment,
  ) => Effect.Effect<
    Awaited<ReturnType<SuccessfulX402Payment['settle']>>,
    PaymentError | ExternalServiceError
  >
}

export const X402Service = Context.GenericTag<X402Service>('buddyPie/X402Service')

const EnvServiceLive = Layer.succeed(EnvService, {
    get(name) {
      return process.env[name]?.trim() || undefined
    },
    require(name) {
      return Effect.gen(function*() {
        const value = process.env[name]?.trim()

        if (!value) {
          return yield* Effect.fail(
            new ConfigError({
              message: `${name} is not configured on the server.`,
            }),
          )
        }

        return value
      })
    },
    resolveConvexHttpUrl(convexUrl: string) {
      return resolveConvexHttpUrl(
        convexUrl,
        process.env.CONVEX_SITE_URL?.trim() || undefined,
      )
    },
  })

const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function*() {
    const env = yield* EnvService
    const convexUrl = yield* env.require('VITE_CONVEX_URL')
    const convexHttpUrl = env.resolveConvexHttpUrl(convexUrl)
    const { ConvexHttpClient } = yield* Effect.tryPromise({
      try: () => import('convex/browser'),
      catch: (error) =>
        new ExternalServiceError({
          service: 'Convex',
          message: normalizeUnknownMessage(
            error,
            'The Convex client could not be loaded.',
          ),
          cause: error,
        }),
    })
    const { auth } = yield* Effect.tryPromise({
      try: () => import('@clerk/tanstack-react-start/server'),
      catch: (error) =>
        new ExternalServiceError({
          service: 'Clerk',
          message: normalizeUnknownMessage(
            error,
            'Clerk server helpers could not be loaded.',
          ),
          cause: error,
        }),
    })
    const convex = new ConvexHttpClient(convexUrl)
    const session = yield* Effect.tryPromise({
      try: () => auth(),
      catch: (error) =>
        new AuthError({
          message: normalizeUnknownMessage(
            error,
            'You must be signed in to continue.',
          ),
          cause: error,
        }),
    })

    if (!session.userId) {
      return yield* Effect.fail(
        new AuthError({
          message: 'You must be signed in to continue.',
        }),
      )
    }

    const token = yield* Effect.tryPromise({
      try: () => session.getToken({ template: 'convex' }),
      catch: (error) =>
        new AuthError({
          message: normalizeUnknownMessage(
            error,
            'Your Convex auth token could not be created.',
          ),
          cause: error,
        }),
    })

    if (!token) {
      return yield* Effect.fail(
        new AuthError({
          message: 'Your Convex auth token could not be created.',
        }),
      )
    }

    convex.setAuth(token)

    return {
      context: {
        convex,
        convexHttpUrl,
        convexUrl,
        token,
        userId: session.userId,
      },
    } satisfies AuthService
  }),
).pipe(Layer.provide(EnvServiceLive))

const ConvexServiceLive = Layer.effect(
  ConvexService,
  Effect.gen(function*() {
    const auth = yield* AuthService

    return {
      context: auth.context,
      ensureCurrentUser: Effect.tryPromise({
        try: () => auth.context.convex.mutation(api.user.ensureCurrentUser, {}),
        catch: (error) =>
          new ExternalServiceError({
            service: 'Convex',
            message: normalizeUnknownMessage(
              error,
              'BuddyPie could not load the current user in Convex.',
            ),
            cause: error,
          }),
      }).pipe(Effect.asVoid),
      getOwnedSandbox: (sandboxId) =>
        Effect.tryPromise({
          try: () =>
            auth.context.convex.query(api.sandboxes.get, {
              sandboxId: sandboxId as Id<'sandboxes'>,
            }),
          catch: (error) =>
            new ExternalServiceError({
              service: 'Convex',
              message: normalizeUnknownMessage(
                error,
                'BuddyPie could not load that sandbox.',
              ),
              cause: error,
            }),
        }).pipe(
          Effect.flatMap((sandbox) =>
            sandbox
              ? Effect.succeed(sandbox)
              : Effect.fail(
                  new SandboxError({
                    message: 'Sandbox not found.',
                  }),
                ),
          ),
        ),
    } satisfies ConvexService
  }),
).pipe(Layer.provide(AuthServiceLive))

const DaytonaServiceLive = Layer.succeed(DaytonaService, {
    createOpenCodeSandbox: (args) =>
      Effect.tryPromise({
        try: () => createOpenCodeSandbox(args),
        catch: (error) =>
        new SandboxError({
          message: normalizeUnknownMessage(
            error,
              'Something went wrong while talking to Daytona.',
            ),
            cause: error,
          }),
      }),
    deleteOpenCodeSandbox: (daytonaSandboxId) =>
      Effect.tryPromise({
        try: () => deleteOpenCodeSandbox(daytonaSandboxId),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Something went wrong while talking to Daytona.',
            ),
            cause: error,
          }),
      }),
    resolveOpenCodeLaunchConfig: (args) =>
      Effect.try({
        try: () => resolveOpenCodeLaunchConfig(args),
        catch: (error) =>
          new ConfigError({
            message: normalizeUnknownMessage(
              error,
              'OpenCode launch configuration is invalid.',
            ),
            cause: error,
          }),
      }),
    ensureSandboxAppPreviewServer: (args) =>
      Effect.tryPromise({
        try: () => ensureSandboxAppPreviewServer(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not start the app preview server.',
            ),
            cause: error,
          }),
      }),
    getSandboxAppPreviewStatus: (args) =>
      Effect.tryPromise({
        try: () => getSandboxAppPreviewStatus(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not inspect the preview status.',
            ),
            cause: error,
          }),
      }),
    getSandboxAppPreviewLogTail: (args) =>
      Effect.tryPromise({
        try: () => getSandboxAppPreviewLogTail(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not load the preview logs.',
            ),
            cause: error,
          }),
      }),
    getSandboxAppPreviewCommandSuggestion: (args) =>
      Effect.tryPromise({
        try: () => getSandboxAppPreviewCommandSuggestion(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not determine a preview command for this repo.',
            ),
            cause: error,
          }),
      }),
    readSandboxCurrentArtifact: (args) =>
      Effect.tryPromise({
        try: () => readSandboxCurrentArtifact(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not load the sandbox artifact manifest.',
            ),
            cause: error,
          }),
      }),
    createSandboxSshAccessCommand: (args) =>
      Effect.tryPromise({
        try: () => createSandboxSshAccessCommand(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not create SSH access.',
            ),
            cause: error,
          }),
      }),
    getSandboxPortPreviewUrl: (args) =>
      Effect.tryPromise({
        try: () => getSandboxPortPreviewUrl(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not open the requested sandbox port.',
            ),
            cause: error,
          }),
      }),
    sendPromptToSandboxOpencodeSession: (args) =>
      Effect.tryPromise({
        try: () => sendPromptToSandboxOpencodeSession(args),
        catch: (error) =>
          new SandboxError({
            message: normalizeUnknownMessage(
              error,
              'Could not send the prompt to the sandbox agent.',
            ),
            cause: error,
          }),
      }),
  })

const BillingServiceLive = Layer.effect(
  BillingService,
  Effect.gen(function*() {
    const convex = yield* ConvexService

    return {
      priceForEvent: (agentPresetId, eventType) =>
        getBillingEventPriceUsdCents(agentPresetId, eventType),
      requireDelegatedBudgetAllowance: ({ requiredAmountUsdCents, actionLabel }) =>
        Effect.tryPromise({
          try: async () => {
            const delegatedBudget = await convex.context.convex.query(
              api.billing.currentDelegatedBudget,
              {},
            )

            if (!delegatedBudget) {
              throw new Error(
                'Set up an active delegated budget before using that payment rail.',
              )
            }

            await assertDelegatedBudgetAllowanceOrThrow({
              budget: delegatedBudget,
              requiredAmountUsdCents,
              actionLabel,
            })

            return delegatedBudget
          },
          catch: (error) =>
            new PaymentError({
              message: normalizeUnknownMessage(
                error,
                'The delegated budget could not be validated.',
              ),
              cause: error,
            }),
        }),
      settleDelegatedBudgetOnchain: (args) =>
        Effect.tryPromise({
          try: () => settleDelegatedBudgetOnchain(args),
          catch: (error) =>
            new PaymentError({
              message: normalizeUnknownMessage(
                error,
                'Delegated-budget settlement failed.',
              ),
              cause: error,
            }),
        }),
    } satisfies BillingService
  }),
).pipe(Layer.provide(ConvexServiceLive))

const X402ServiceLive = Layer.succeed(X402Service, {
    requirePayment: (args) =>
      Effect.tryPromise({
        try: () => requireX402Payment(args),
        catch: (error) =>
          new ConfigError({
            message: normalizeUnknownMessage(
              error,
              'x402 is not configured correctly.',
            ),
            cause: error,
          }),
      }),
    settlePayment: (payment) =>
      Effect.tryPromise({
        try: () => payment.settle(),
        catch: (error) =>
          new PaymentError({
            message: normalizeUnknownMessage(
              error,
              'x402 settlement was not successful',
            ),
            cause: error,
              }),
      }),
  })

export const ServerServicesLive = Layer.mergeAll(
  EnvServiceLive,
  AuthServiceLive,
  ConvexServiceLive,
  DaytonaServiceLive,
  BillingServiceLive,
  X402ServiceLive,
)
