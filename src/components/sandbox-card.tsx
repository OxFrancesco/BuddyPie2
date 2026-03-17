import { Link } from '@tanstack/react-router'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '~/components/ui/card'
import { StatusPill } from '~/components/status-pill'
import { getSafeOpenCodeAgentPreset } from '~/lib/opencode/presets'

type SandboxCardProps = {
  sandbox: {
    _id: string
    repoName: string
    repoUrl: string
    repoBranch?: string
    repoProvider: 'github' | 'git'
    agentPresetId?: string
    agentLabel?: string
    agentProvider?: string
    agentModel?: string
    initialPrompt?: string
    status: 'creating' | 'ready' | 'failed'
    previewUrl?: string
    errorMessage?: string
    workspacePath?: string
    billedUsdCents?: number
  }
  isBusy?: boolean
  onDelete: () => void
  onRestart: () => void
}

export function SandboxCard({
  sandbox,
  isBusy,
  onDelete,
  onRestart,
}: SandboxCardProps) {
  const preset = getSafeOpenCodeAgentPreset(sandbox.agentPresetId)
  const presetLabel = sandbox.agentLabel ?? preset.label

  return (
    <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={sandbox.status} />
            <Badge variant="outline" className="border-2 border-foreground font-bold uppercase tracking-widest">
              {presetLabel}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRestart}
              disabled={isBusy}
              className="border-2 border-foreground text-xs font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
            >
              Restart
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onDelete}
              disabled={isBusy}
              className="border-2 border-foreground text-xs font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
            >
              Delete
            </Button>
          </div>
        </div>
        <CardTitle className="mt-2 text-xl font-black">{sandbox.repoName}</CardTitle>
        <p className="break-all text-sm text-muted-foreground">{sandbox.repoUrl}</p>
      </CardHeader>

      <CardContent>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="border-2 border-foreground bg-muted p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Branch
            </p>
            <p className="mt-1 font-bold">{sandbox.repoBranch || 'default'}</p>
          </div>
          <div className="border-2 border-foreground bg-muted p-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Workspace
            </p>
            <p className="mt-1 break-all font-bold">
              {sandbox.workspacePath || 'Provisioning...'}
            </p>
          </div>
          <div className="border-2 border-foreground bg-muted p-3 lg:col-span-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Billed usage
            </p>
            <p className="mt-1 font-bold">
              ${((sandbox.billedUsdCents ?? 0) / 100).toFixed(2)}
            </p>
          </div>
        </div>

        {sandbox.errorMessage ? (
          <div className="mt-3 border-2 border-foreground bg-destructive p-3 text-sm font-bold text-white">
            {sandbox.errorMessage}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex-wrap gap-3 border-t-2 border-foreground">
        <Button
          asChild
          className="border-2 border-foreground bg-foreground text-sm font-black uppercase tracking-wider text-background shadow-[3px_3px_0_var(--accent)] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
        >
          <Link to="/sandboxes/$sandboxId" params={{ sandboxId: sandbox._id }}>
            Open workspace →
          </Link>
        </Button>

        {sandbox.previewUrl ? (
          <Button
            asChild
            variant="outline"
            className="border-2 border-foreground text-sm font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
          >
            <a href={sandbox.previewUrl} target="_blank" rel="noreferrer">
              Preview
            </a>
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">
            {sandbox.status === 'failed'
              ? 'Launch failed. Restart after reviewing the error.'
              : 'Preview appears when sandbox is ready.'}
          </span>
        )}
      </CardFooter>
    </Card>
  )
}
