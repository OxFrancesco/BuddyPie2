export type PreviewBootResult = {
  status: 'already-running' | 'started'
  port: number
  previewUrl: string
  previewAppPath?: string
}

export type TerminalAccessResult = {
  sshCommand: string
  expiresAt: string | number
}

export type PortPreviewResult = {
  previewUrl: string
  port: number
}

export type PreviewCommandSuggestionResult = {
  command: string
  framework: string
  packageManager: string
  previewScript: string
  workspacePath: string
  previewAppPath: string
}

export type PreviewLogResult = {
  output: string
  logPath: string
  previewAppPath?: string
}

export type RestartResult = {
  sandboxId: string
  previewUrl?: string
  agentPresetId: string
}

export type UtilityDrawerTab = 'artifacts' | 'preview'

export type DelegatedBudgetSummary = {
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

export type SandboxDetailRecord = {
  _id: string
  status: 'creating' | 'ready' | 'failed'
  repoName: string
  repoUrl?: string | null
  repoBranch?: string | null
  repoProvider?: string | null
  agentPresetId?: string | null
  agentLabel?: string | null
  agentProvider?: string | null
  agentModel?: string | null
  pendingPaymentMethod?: string | null
  previewUrl?: string | null
  previewUrlPattern?: string | null
  previewAppPath?: string | null
  workspacePath?: string | null
  daytonaSandboxId?: string | null
  opencodeSessionId?: string | null
  errorMessage?: string | null
}
