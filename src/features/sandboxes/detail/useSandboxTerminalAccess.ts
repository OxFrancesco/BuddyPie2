import { useState } from 'react'
import {
  createTerminalAccess,
  getPortPreview,
} from '~/features/sandboxes/server'
import { postJsonWithX402Payment } from '~/lib/billing/x402-client'
import {
  isX402SandboxPaymentMethod,
  type SandboxPaymentMethod,
} from '~/lib/sandboxes'
import type {
  PortPreviewResult,
  SandboxDetailRecord,
  TerminalAccessResult,
} from './types'

export function useSandboxTerminalAccess(args: {
  sandbox: SandboxDetailRecord | null | undefined
  paymentMethod: SandboxPaymentMethod
  hasActiveDelegatedBudget: boolean
  delegatedBudgetHealthMessage?: string | null
  x402ChainId: number
  refreshSandboxQueries: () => Promise<void>
  onDelegatedBudgetBlocked: () => void
}) {
  const [sshCommand, setSshCommand] = useState<string | null>(null)
  const [sshExpiresAt, setSshExpiresAt] = useState<string | null>(null)
  const [terminalAccessError, setTerminalAccessError] = useState<string | null>(
    null,
  )
  const [isTerminalAccessLoading, setIsTerminalAccessLoading] = useState(false)
  const [webTerminalError, setWebTerminalError] = useState<string | null>(null)
  const [isWebTerminalLoading, setIsWebTerminalLoading] = useState(false)
  const [webTerminalUrl, setWebTerminalUrl] = useState<string | null>(null)

  async function handleCreateTerminalAccess() {
    if (!args.sandbox) {
      return
    }

    setIsTerminalAccessLoading(true)
    setTerminalAccessError(null)

    if (
      args.paymentMethod === 'delegated_budget' &&
      !args.hasActiveDelegatedBudget
    ) {
      args.onDelegatedBudgetBlocked()
      setIsTerminalAccessLoading(false)
      return
    }

    try {
      const access = isX402SandboxPaymentMethod(args.paymentMethod)
        ? await postJsonWithX402Payment<TerminalAccessResult>({
            url: `/api/x402/sandboxes/${args.sandbox._id}/ssh`,
            body: {
              expiresInMinutes: 60,
            },
            chainId: args.x402ChainId,
          })
        : await createTerminalAccess({
            data: {
              sandboxId: args.sandbox._id,
              expiresInMinutes: 60,
              paymentMethod: args.paymentMethod,
            } as any,
          })

      setSshCommand(access.sshCommand)
      setSshExpiresAt(String(access.expiresAt))
      await args.refreshSandboxQueries()
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
    if (!args.sandbox) {
      return
    }

    setIsWebTerminalLoading(true)
    setWebTerminalError(null)

    if (
      args.paymentMethod === 'delegated_budget' &&
      !args.hasActiveDelegatedBudget
    ) {
      args.onDelegatedBudgetBlocked()
      setIsWebTerminalLoading(false)
      return
    }

    try {
      const preview = isX402SandboxPaymentMethod(args.paymentMethod)
        ? await postJsonWithX402Payment<PortPreviewResult>({
            url: `/api/x402/sandboxes/${args.sandbox._id}/web-terminal`,
            body: {},
            chainId: args.x402ChainId,
          })
        : await getPortPreview({
            data: {
              sandboxId: args.sandbox._id,
              port: 22222,
              paymentMethod: args.paymentMethod,
            } as any,
          })

      setWebTerminalUrl(preview.previewUrl)
      window.open(preview.previewUrl, '_blank', 'noopener,noreferrer')
      await args.refreshSandboxQueries()
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

  return {
    sshCommand,
    sshExpiresAt,
    terminalAccessError,
    isTerminalAccessLoading,
    webTerminalError,
    isWebTerminalLoading,
    webTerminalUrl,
    handleCreateTerminalAccess,
    handleOpenWebTerminal,
  }
}
