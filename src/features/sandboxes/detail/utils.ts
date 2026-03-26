import { formatUsdCents } from '~/lib/billing/format'
import type { DelegatedBudgetSummary, UtilityDrawerTab } from './types'

export const SWIPE_DISTANCE_PX = 60
export const APP_PREVIEW_PORT_MIN = 3000
export const APP_PREVIEW_PORT_MAX = 9999
export const DEFAULT_APP_PREVIEW_PORT = '5173'
export const QUICK_PREVIEW_PORTS = ['5173', '4173', '3001', '8080'] as const
export const PREVIEW_TERMINAL_FALLBACK_DELAY_MS = 10_000

export function derivePreviewUrlPattern(
  previewUrl?: string | null,
  previewUrlPattern?: string | null,
) {
  if (previewUrlPattern?.includes('{PORT}')) {
    return previewUrlPattern
  }

  if (!previewUrl || !previewUrl.includes('3000')) {
    return null
  }

  return previewUrl.replace('3000', '{PORT}')
}

export function isValidPreviewPort(value: string) {
  const port = Number(value)
  return (
    Number.isInteger(port) &&
    port >= APP_PREVIEW_PORT_MIN &&
    port <= APP_PREVIEW_PORT_MAX
  )
}

export function formatDateTime(value?: string | number | null) {
  if (!value) {
    return null
  }

  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return String(value)
  }

  return parsedDate.toLocaleString()
}

export function formatRemainingBudgetDisplay(
  summary: DelegatedBudgetSummary | undefined,
) {
  if (!summary) {
    return '—'
  }

  const remaining = summary.remainingAmountUsdCents
  const configured = summary.configuredAmountUsdCents

  if (remaining != null && configured != null) {
    return `${formatUsdCents(remaining)} / ${formatUsdCents(configured)}`
  }

  if (remaining != null) {
    return formatUsdCents(remaining)
  }

  return '—'
}

export function getInitialUtilityDrawerTab(
  agentPresetId?: string | null,
): UtilityDrawerTab {
  return agentPresetId === 'nansen-analyst' ? 'artifacts' : 'preview'
}
