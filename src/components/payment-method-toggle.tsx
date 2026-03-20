import type { SandboxPaymentMethod } from '~/lib/sandboxes'
import { cn } from '~/lib/utils'

type PaymentMethodToggleProps = {
  value: SandboxPaymentMethod
  onChange: (value: SandboxPaymentMethod) => void
  className?: string
  creditsDescription?: string
  x402Description?: string
  delegatedBudgetDescription?: string
  delegatedBudgetDisabled?: boolean
}

export function PaymentMethodToggle({
  value,
  onChange,
  className,
  creditsDescription = 'Spend from your shared BuddyPie wallet.',
  x402Description = 'Pay per action from your wallet with x402.',
  delegatedBudgetDescription = 'Spend from a preapproved MetaMask delegated budget.',
  delegatedBudgetDisabled = false,
}: PaymentMethodToggleProps) {
  return (
    <div className={cn('grid gap-3 md:grid-cols-3', className)}>
      <button
        type="button"
        onClick={() => onChange('credits')}
        className={cn(
          'rounded-lg border-2 border-foreground p-4 text-left shadow-[3px_3px_0_var(--foreground)] transition-all',
          value === 'credits'
            ? 'translate-x-[2px] translate-y-[2px] bg-accent shadow-none'
            : 'bg-background hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none',
        )}
      >
        <p className="text-sm font-black uppercase tracking-wide">Credits</p>
        <p className="mt-2 text-xs text-muted-foreground">{creditsDescription}</p>
      </button>

      <button
        type="button"
        onClick={() => onChange('x402')}
        className={cn(
          'rounded-lg border-2 border-foreground p-4 text-left shadow-[3px_3px_0_var(--foreground)] transition-all',
          value === 'x402'
            ? 'translate-x-[2px] translate-y-[2px] bg-accent shadow-none'
            : 'bg-background hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none',
        )}
      >
        <p className="text-sm font-black uppercase tracking-wide">x402</p>
        <p className="mt-2 text-xs text-muted-foreground">{x402Description}</p>
      </button>

      <button
        type="button"
        onClick={() => {
          if (!delegatedBudgetDisabled) {
            onChange('delegated_budget')
          }
        }}
        disabled={delegatedBudgetDisabled}
        className={cn(
          'rounded-lg border-2 border-foreground p-4 text-left shadow-[3px_3px_0_var(--foreground)] transition-all',
          value === 'delegated_budget'
            ? 'translate-x-[2px] translate-y-[2px] bg-accent shadow-none'
            : 'bg-background hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none',
          delegatedBudgetDisabled
            ? 'cursor-not-allowed opacity-60 hover:translate-x-0 hover:translate-y-0 hover:shadow-[3px_3px_0_var(--foreground)]'
            : '',
        )}
      >
        <p className="text-sm font-black uppercase tracking-wide">
          Delegated budget
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {delegatedBudgetDescription}
        </p>
      </button>
    </div>
  )
}
