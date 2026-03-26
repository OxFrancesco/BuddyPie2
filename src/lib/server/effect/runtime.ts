import { Effect, Layer } from 'effect'
import { toHttpResponse, toServerError, type DomainError } from './errors'
import { ServerServicesLive } from './services'

export function runServerProgram<A, R>(
  program: Effect.Effect<A, DomainError, R>,
  options?: {
    layer?: Layer.Layer<any, any, any>
  },
) {
  const layer = options?.layer ?? ServerServicesLive
  const provided = Effect.scoped(
    Effect.provide(
      program,
      layer,
    ),
  ) as Effect.Effect<A, DomainError, never>

  return Effect.runPromise(provided).catch((error) =>
    Promise.reject(toServerError(error)),
  )
}

export function runRouteProgram<R>(
  program: Effect.Effect<Response, DomainError, R>,
  options?: {
    defaultStatus?: number
    layer?: Layer.Layer<any, any, any>
  },
) {
  const layer = options?.layer ?? ServerServicesLive
  const provided = Effect.scoped(program.pipe(
    Effect.catchAll((error) =>
      Effect.succeed(toHttpResponse(error, options?.defaultStatus ?? 400)),
    ),
    Effect.provide(layer),
  )) as Effect.Effect<Response, never, never>

  return Effect.runPromise(
    provided,
  )
}
