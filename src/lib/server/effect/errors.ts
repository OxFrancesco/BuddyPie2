import { Data } from 'effect'

export class AuthError extends Data.TaggedError('AuthError')<{
  message: string
  cause?: unknown
}> {}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  message: string
  cause?: unknown
}> {}

export class SandboxError extends Data.TaggedError('SandboxError')<{
  message: string
  cause?: unknown
}> {}

export class PaymentError extends Data.TaggedError('PaymentError')<{
  message: string
  cause?: unknown
}> {}

export class ExternalServiceError extends Data.TaggedError('ExternalServiceError')<{
  service: string
  message: string
  cause?: unknown
}> {}

export class ValidationError extends Data.TaggedError('ValidationError')<{
  message: string
  cause?: unknown
}> {}

export type DomainError =
  | AuthError
  | ConfigError
  | SandboxError
  | PaymentError
  | ExternalServiceError
  | ValidationError

const DOMAIN_ERROR_TAGS = new Set([
  'AuthError',
  'ConfigError',
  'SandboxError',
  'PaymentError',
  'ExternalServiceError',
  'ValidationError',
])

export function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    typeof error._tag === 'string' &&
    DOMAIN_ERROR_TAGS.has(error._tag)
  )
}

export function toUserMessage(
  error: unknown,
  fallback = 'Something went wrong.',
) {
  if (isDomainError(error)) {
    return error.message
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return fallback
}

export function toConvexFailureMessage(error: unknown) {
  return toUserMessage(error)
}

export function toHttpResponse(error: unknown, defaultStatus = 400) {
  const status = isDomainError(error)
    ? error._tag === 'AuthError'
      ? 401
      : error._tag === 'ConfigError'
        ? 500
        : error._tag === 'ValidationError'
          ? 400
          : error._tag === 'ExternalServiceError'
            ? 502
            : defaultStatus
    : defaultStatus

  return Response.json(
    { error: toUserMessage(error) },
    {
      status,
    },
  )
}

export function toServerError(error: unknown) {
  if (error instanceof Error && !isDomainError(error)) {
    return error
  }

  const wrapped = new Error(toUserMessage(error))
  ;(wrapped as Error & { cause?: unknown }).cause = error
  return wrapped
}
