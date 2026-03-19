import { useState } from 'react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  createDelegatedBudget,
  refreshDelegatedBudgetState,
  revokeDelegatedBudget,
} from '~/features/billing/server'
import {
  createDelegatedBudgetWithWallet,
  revokeDelegatedBudgetWithWallet,
} from '~/lib/billing/delegated-budget-client'
import { formatUsdCents } from '~/lib/billing/format'
import type { DelegatedBudgetInterval } from '~/lib/billing/delegated-budget-contract'
import { cn } from '~/lib/utils'

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

type DelegatedBudgetRecord = {
  _id: string
  contractBudgetId: string
  delegationJson: string
  settlementContract?: string
  lastSettlementTxHash?: string
} | null

type DelegatedBudgetEnvironment = {
  chainId: number
  delegatedBudget: {
    enabled: boolean
    network: string
    tokenAddress: string
    tokenSymbol: 'USDC'
    settlementContract: string
    treasuryAddress: string
    backendDelegateAddress: string
  }
}

type DelegatedBudgetManagerProps = {
  id?: string
  summary?: DelegatedBudgetSummary | null
  record?: DelegatedBudgetRecord
  environment: DelegatedBudgetEnvironment
  onUpdated: () => Promise<void>
  onSelectRail?: () => void
  className?: string
  compact?: boolean
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

export function DelegatedBudgetManager({
  id,
  summary,
  record,
  environment,
  onUpdated,
  onSelectRail,
  className,
  compact = false,
}: DelegatedBudgetManagerProps) {
  const [amount, setAmount] = useState('25')
  const [budgetType, setBudgetType] = useState<'fixed' | 'periodic'>('fixed')
  const [interval, setInterval] = useState<DelegatedBudgetInterval>('month')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isConfigured = environment.delegatedBudget.enabled
  const hasActiveBudget = summary?.status === 'active' && record

  async function handleCreateBudget() {
    const parsedAmount = Number(amount)

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a delegated budget amount greater than zero.')
      return
    }

    if (!isConfigured) {
      setError('Delegated budgets are not configured in this environment yet.')
      return
    }

    setIsSubmitting(true)
    setError(null)
    setSuccess(null)

    try {
      const setup = await createDelegatedBudgetWithWallet({
        amountUsdCents: Math.round(parsedAmount * 100),
        budgetType,
        interval: budgetType === 'periodic' ? interval : null,
        chainId: environment.chainId,
        backendDelegateAddress: environment.delegatedBudget.backendDelegateAddress,
        tokenAddress: environment.delegatedBudget.tokenAddress,
        treasuryAddress: environment.delegatedBudget.treasuryAddress,
      })

      await createDelegatedBudget({
        data: setup,
      })
      await onUpdated()
      onSelectRail?.()
      setSuccess('Delegated budget created and ready to use.')
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'Could not create the delegated budget.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRefreshBudget() {
    if (!record) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    setSuccess(null)

    try {
      await refreshDelegatedBudgetState({
        data: {
          delegatedBudgetId: record._id,
          ...(record.lastSettlementTxHash
            ? { lastSettlementTxHash: record.lastSettlementTxHash }
            : {}),
        },
      })
      await onUpdated()
      setSuccess('Delegated budget state refreshed from chain.')
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Could not refresh delegated budget state.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRevokeBudget() {
    if (!record) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    setSuccess(null)

    try {
      const revokeResult = await revokeDelegatedBudgetWithWallet({
        chainId: environment.chainId,
        delegationJson: record.delegationJson,
      })

      await revokeDelegatedBudget({
        data: {
          delegatedBudgetId: record._id,
          revokeTxHash: revokeResult.txHash,
        },
      })
      await onUpdated()
      setSuccess('Delegated budget revoked.')
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : 'Could not revoke the delegated budget.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      id={id}
      className={cn(
        'border-2 border-foreground bg-background p-4 shadow-[3px_3px_0_var(--foreground)]',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
            Delegated budget
          </p>
          <p className="mt-1 text-sm font-black uppercase">
            {hasActiveBudget ? 'Active' : isConfigured ? 'Setup required' : 'Unavailable'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelectRail?.()}
            className="border-2 border-foreground text-xs font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
          >
            Use rail
          </Button>
          {hasActiveBudget ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefreshBudget}
              disabled={isSubmitting}
              className="border-2 border-foreground text-xs font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
            >
              Refresh
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-3 border-2 border-foreground">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {success ? (
        <Alert className="mt-3 border-2 border-foreground">
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      ) : null}

      {hasActiveBudget && summary ? (
        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
          <p>
            {summary.type === 'periodic'
              ? `Periodic ${summary.interval ?? 'custom'} budget`
              : 'Fixed budget'}
          </p>
          <p>Remaining: {formatUsdCents(summary.remainingAmountUsdCents ?? 0)}</p>
          <p>
            Configured: {formatUsdCents(summary.configuredAmountUsdCents ?? 0)}
          </p>
          <p>Network: {summary.network ?? environment.delegatedBudget.network}</p>
          <p>Delegate: {summary.delegateAddress ?? 'Not assigned yet.'}</p>
          {summary.periodEndsAt ? (
            <p>Current period ends: {formatDateTime(summary.periodEndsAt)}</p>
          ) : null}
          {summary.lastSettlementAt ? (
            <p>Last settlement: {formatDateTime(summary.lastSettlementAt)}</p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRevokeBudget}
              disabled={isSubmitting}
              className="border-2 border-foreground text-xs font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
            >
              Revoke
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {!isConfigured ? (
            <p className="text-xs text-muted-foreground">
              Configure the delegated-budget treasury and backend delegate
              environment variables before using this rail.
            </p>
          ) : (
            <>
              <div className={cn('grid gap-3', compact ? 'grid-cols-1' : 'md:grid-cols-3')}>
                <label className="flex flex-col gap-2 text-xs font-bold uppercase tracking-wide">
                  Budget amount (USD)
                  <Input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="decimal"
                    placeholder="25"
                  />
                </label>

                <div className="flex flex-col gap-2 text-xs font-bold uppercase tracking-wide">
                  Budget type
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={budgetType === 'fixed' ? 'default' : 'outline'}
                      onClick={() => setBudgetType('fixed')}
                      className="border-2 border-foreground text-xs font-bold uppercase"
                    >
                      Fixed
                    </Button>
                    <Button
                      type="button"
                      variant={budgetType === 'periodic' ? 'default' : 'outline'}
                      onClick={() => setBudgetType('periodic')}
                      className="border-2 border-foreground text-xs font-bold uppercase"
                    >
                      Periodic
                    </Button>
                  </div>
                </div>

                {budgetType === 'periodic' ? (
                  <div className="flex flex-col gap-2 text-xs font-bold uppercase tracking-wide">
                    Interval
                    <div className="grid grid-cols-3 gap-2">
                      {(['day', 'week', 'month'] as const).map((option) => (
                        <Button
                          key={option}
                          type="button"
                          variant={interval === option ? 'default' : 'outline'}
                          onClick={() => setInterval(option)}
                          className="border-2 border-foreground text-xs font-bold uppercase"
                        >
                          {option}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <p className="text-xs text-muted-foreground">
                Setup stores a smart-account delegation with a treasury-bound USDC
                spend limit so later agent spends can settle without repeated wallet
                prompts.
              </p>

              <Button
                type="button"
                onClick={handleCreateBudget}
                disabled={isSubmitting}
                className="border-2 border-foreground font-black uppercase shadow-[3px_3px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
              >
                {isSubmitting ? 'Preparing budget...' : 'Create delegated budget'}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
