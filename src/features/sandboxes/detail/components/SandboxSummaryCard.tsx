import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { StatusPill } from '~/components/status-pill'
import { formatSandboxPaymentMethod } from '~/lib/billing/presentation'
import {
  getSandboxBaseBranchDisplay,
  getSandboxRepositoryDisplay,
  type SandboxPaymentMethod,
} from '~/lib/sandboxes'
import type { SandboxDetailRecord } from '../types'

export function SandboxSummaryCard(props: {
  sandbox: SandboxDetailRecord
  presetLabel: string
  paymentMethod: SandboxPaymentMethod
  providerLabel: string
  modelLabel: string
  remainingBudgetDisplay: string
  error?: string | null
  showDelegatedBudgetLink?: boolean
  isBusy: boolean
  onRestart: () => void
  onDelete: () => void
  footer?: ReactNode
}) {
  return (
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
              <StatusPill status={props.sandbox.status} />
              <Badge
                variant="outline"
                className="border-2 border-foreground font-bold uppercase tracking-widest"
              >
                {props.presetLabel}
              </Badge>
              <Badge
                variant="outline"
                className="border-2 border-foreground font-bold uppercase tracking-widest"
              >
                {formatSandboxPaymentMethod(props.paymentMethod)}
              </Badge>
            </div>
            <CardTitle className="text-3xl font-black uppercase sm:text-4xl">
              {props.sandbox.repoName}
            </CardTitle>
            <p className="break-all text-sm text-muted-foreground">
              {getSandboxRepositoryDisplay(props.sandbox.repoUrl)}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={props.onRestart}
              disabled={props.isBusy}
              className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
            >
              Restart
            </Button>
            <Button
              variant="destructive"
              onClick={props.onDelete}
              disabled={props.isBusy}
              className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
            >
              Delete
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {props.error ? (
          <Alert
            variant="destructive"
            className="mb-4 border-2 border-foreground"
          >
            <AlertDescription className="space-y-3">
              <p>{props.error}</p>
              {props.showDelegatedBudgetLink ? (
                <Link
                  to="/profile"
                  hash="delegated-budget"
                  className="inline-flex h-8 items-center justify-center border-2 border-background bg-background px-4 text-xs font-black uppercase tracking-wider text-foreground shadow-[2px_2px_0_var(--foreground)] transition-all hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
                >
                  Go to wallet
                </Link>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="border-2 border-foreground bg-muted p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Base Branch
            </p>
            <p className="mt-1 font-bold">
              {getSandboxBaseBranchDisplay({
                repoUrl: props.sandbox.repoUrl,
                repoBranch: props.sandbox.repoBranch,
              })}
            </p>
          </div>
          <div className="border-2 border-foreground bg-muted p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Provider
            </p>
            <p className="mt-1 font-bold">{props.providerLabel}</p>
          </div>
          <div className="border-2 border-foreground bg-muted p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Model
            </p>
            <p className="mt-1 break-all font-bold">{props.modelLabel}</p>
          </div>
          <div className="border-2 border-foreground bg-muted p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Remaining budget
            </p>
            <p className="mt-1 font-bold tabular-nums">
              {props.remainingBudgetDisplay}
            </p>
          </div>
        </div>

        {props.footer ? <div className="mt-6">{props.footer}</div> : null}
      </CardContent>
    </Card>
  )
}
