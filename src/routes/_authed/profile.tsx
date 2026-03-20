import { useEffect, useRef, useState } from 'react'
import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query'
import { useQuery } from '@tanstack/react-query'
import { api } from 'convex/_generated/api'
import { DelegatedBudgetManager } from '~/components/delegated-budget-manager'
import { PaymentMethodToggle } from '~/components/payment-method-toggle'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import {
  readCurrentDelegatedBudgetHealth,
  syncCurrentClerkBillingState,
} from '~/features/billing/server'
import { formatUsdCents } from '~/lib/billing/format'
import {
  formatBillingPlanPeriod,
  formatBillingPlanStatus,
} from '~/lib/billing/presentation'
import type { SandboxPaymentMethod } from '~/lib/sandboxes'

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

export const Route = createFileRoute('/_authed/profile')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(convexQuery(api.user.current, {})),
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.dashboardSummary, {}),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.pricingCatalog, {}),
      ),
      context.queryClient.ensureQueryData(
        convexQuery(api.billing.currentDelegatedBudget, {}),
      ),
    ])
  },
  component: ProfileRoute,
})

function ProfileRoute() {
  const queryClient = useQueryClient()
  const { data: billingSummary } = useSuspenseQuery(
    convexQuery(api.billing.dashboardSummary, {}),
  )
  const { data: pricingCatalog } = useSuspenseQuery(
    convexQuery(api.billing.pricingCatalog, {}),
  )
  const { data: delegatedBudgetRecord } = useSuspenseQuery(
    convexQuery(api.billing.currentDelegatedBudget, {}),
  )
  const [paymentMethod, setPaymentMethod] =
    useState<SandboxPaymentMethod>('credits')
  const [billingError, setBillingError] = useState<string | null>(null)
  const [billingSuccess, setBillingSuccess] = useState<string | null>(null)
  const [isBillingSyncing, setIsBillingSyncing] = useState(false)
  const hasAutoSyncedBilling = useRef(false)

  const billingSummaryView = billingSummary as typeof billingSummary & {
    currentPlan?: { status?: string | null; period?: 'month' | 'annual' | null }
    delegatedBudget?: DelegatedBudgetSummary
  }
  const currentPlan = billingSummaryView.currentPlan
  const delegatedBudget = billingSummaryView.delegatedBudget

  const delegatedBudgetHealthQuery = useQuery({
    queryKey: [
      'billing',
      'delegated-budget-health',
      delegatedBudgetRecord?._id ?? 'none',
    ],
    queryFn: () => readCurrentDelegatedBudgetHealth(),
    staleTime: 15_000,
  })
  const delegatedBudgetHealth = delegatedBudgetHealthQuery.data
  const hasActiveDelegatedBudget =
    delegatedBudget?.status === 'active' &&
    delegatedBudgetHealth?.health === 'usable'

  useEffect(() => {
    if (hasAutoSyncedBilling.current) {
      return
    }

    hasAutoSyncedBilling.current = true

    void syncBillingState(false)
  }, [])

  async function refreshProfile() {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.billing.dashboardSummary, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.billing.pricingCatalog, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: convexQuery(api.billing.currentDelegatedBudget, {}).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: ['billing', 'delegated-budget-health'],
      }),
    ])
  }

  async function syncBillingState(showFeedback: boolean) {
    setIsBillingSyncing(true)

    if (showFeedback) {
      setBillingError(null)
      setBillingSuccess(null)
    }

    try {
      const result = await syncCurrentClerkBillingState()
      await refreshProfile()

      if (!showFeedback) {
        return
      }

      if (!result.synced) {
        setBillingSuccess(
          result.reason === 'billing_disabled'
            ? 'Clerk Billing is disabled in this Clerk environment.'
            : 'No active Clerk billing subscription was found to sync.',
        )
        return
      }

      setBillingSuccess(
        result.grantApplied
          ? 'Clerk billing state refreshed and new plan credits were granted.'
          : 'Clerk billing state refreshed.',
      )
    } catch (error) {
      if (showFeedback) {
        setBillingError(
          error instanceof Error
            ? error.message
            : 'Could not sync Clerk billing state.',
        )
      }
    } finally {
      setIsBillingSyncing(false)
    }
  }

  return (
    <main className="flex flex-col gap-8">
      <section>
        <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
          <CardHeader>
            <CardTitle className="text-2xl font-black uppercase sm:text-3xl">
              Profile &amp; Billing
            </CardTitle>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Manage your wallet, subscription, and payment rails.
            </p>
          </CardHeader>

          <CardContent className="flex flex-col gap-6">
            {billingError ? (
              <Alert
                variant="destructive"
                className="border-2 border-foreground"
              >
                <AlertDescription>{billingError}</AlertDescription>
              </Alert>
            ) : null}

            {billingSuccess ? (
              <Alert className="border-2 border-foreground">
                <AlertDescription>{billingSuccess}</AlertDescription>
              </Alert>
            ) : null}

            {isBillingSyncing ? (
              <p className="text-sm text-muted-foreground">
                Syncing billing state...
              </p>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="border-2 border-foreground bg-muted p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Wallet available
                  </p>
                  <p className="mt-1 text-lg font-black">
                    {formatUsdCents(billingSummary.wallet.availableUsdCents)}
                  </p>
                </div>
                <div className="border-2 border-foreground bg-muted p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Wallet held
                  </p>
                  <p className="mt-1 text-lg font-black">
                    {formatUsdCents(billingSummary.wallet.heldUsdCents)}
                  </p>
                </div>
                <div className="border-2 border-foreground bg-muted p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    Subscription
                  </p>
                  <p className="mt-1 text-sm font-black uppercase">
                    {formatBillingPlanStatus(currentPlan?.status)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatBillingPlanPeriod(
                      currentPlan?.period ?? undefined,
                    ) ?? 'No billing period'}
                  </p>
                </div>
              </div>

              <DelegatedBudgetManager
                id="delegated-budget"
                summary={delegatedBudget}
                record={delegatedBudgetRecord}
                health={delegatedBudgetHealth}
                environment={pricingCatalog.environment}
                onUpdated={refreshProfile}
                onSelectRail={() => {
                  setPaymentMethod('delegated_budget')
                }}
              />
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-black uppercase tracking-widest">
                Payment Rail
              </p>
              <p className="text-sm text-muted-foreground">
                Choose how sandbox launches and restarts are paid. This
                preference is used on the dashboard.
              </p>
              <PaymentMethodToggle
                value={paymentMethod}
                onChange={(nextValue) => {
                  setPaymentMethod(nextValue)
                }}
                creditsDescription="Spend from your shared wallet."
                x402Description={`Settle directly on ${billingSummary.wallet.fundingNetwork}.`}
                delegatedBudgetDescription={
                  hasActiveDelegatedBudget
                    ? 'Spend from your active MetaMask delegated budget.'
                    : delegatedBudgetHealth?.message ??
                      'Create a MetaMask delegated budget before using this rail.'
                }
                delegatedBudgetDisabled={!hasActiveDelegatedBudget}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                onClick={() => {
                  void syncBillingState(true)
                }}
                disabled={isBillingSyncing}
                className="border-2 border-foreground bg-foreground px-6 text-sm font-black uppercase tracking-wider text-background shadow-[4px_4px_0_var(--accent)] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
              >
                {isBillingSyncing ? 'Syncing...' : 'Sync billing'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Pull the latest subscription and wallet state from Clerk.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  )
}
