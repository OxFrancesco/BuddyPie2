import { describe, expect, test } from 'bun:test'
import {
  derivePreviewUrlPattern,
  formatRemainingBudgetDisplay,
  getInitialUtilityDrawerTab,
  isValidPreviewPort,
} from '../src/features/sandboxes/detail/utils.ts'

describe('sandbox detail preview helpers', () => {
  test('derives a port placeholder from the sandbox preview URL when needed', () => {
    expect(
      derivePreviewUrlPattern(
        'https://3000-sandbox.proxy.daytona.works/',
        undefined,
      ),
    ).toBe('https://{PORT}-sandbox.proxy.daytona.works/')
  })

  test('preserves an explicit preview pattern', () => {
    expect(
      derivePreviewUrlPattern(
        'https://3000-sandbox.proxy.daytona.works/',
        'https://{PORT}-sandbox.proxy.daytona.works/',
      ),
    ).toBe('https://{PORT}-sandbox.proxy.daytona.works/')
  })

  test('validates preview ports against the supported range', () => {
    expect(isValidPreviewPort('5173')).toBe(true)
    expect(isValidPreviewPort('2999')).toBe(false)
    expect(isValidPreviewPort('10000')).toBe(false)
    expect(isValidPreviewPort('abc')).toBe(false)
  })
})

describe('sandbox detail budget helpers', () => {
  test('formats configured and remaining delegated budget amounts', () => {
    expect(
      formatRemainingBudgetDisplay({
        remainingAmountUsdCents: 1250,
        configuredAmountUsdCents: 5000,
      }),
    ).toBe('$12.50 / $50.00')
  })
})

describe('sandbox detail drawer defaults', () => {
  test('opens the artifacts tab first for the nansen preset', () => {
    expect(getInitialUtilityDrawerTab('nansen-analyst')).toBe('artifacts')
    expect(getInitialUtilityDrawerTab('general-engineer')).toBe('preview')
    expect(getInitialUtilityDrawerTab(undefined)).toBe('preview')
  })
})
