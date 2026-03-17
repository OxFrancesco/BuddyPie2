export function formatUsdCents(amountUsdCents = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountUsdCents / 100)
}

export function parseUsdInputToCents(rawValue: string) {
  const normalized = rawValue.trim()

  if (!normalized) {
    throw new Error('Enter a USD amount before continuing.')
  }

  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) {
    throw new Error('Use a valid USD amount with up to two decimal places.')
  }

  return Math.round(Number(normalized) * 100)
}
