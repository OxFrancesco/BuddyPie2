import type { SandboxDetailRecord } from '../types'

export function SandboxWorkspaceFrame(props: { sandbox: SandboxDetailRecord }) {
  return (
    <div className="border-2 border-foreground bg-card shadow-[4px_4px_0_var(--foreground)]">
      {props.sandbox.previewUrl && props.sandbox.status === 'ready' ? (
        <div>
          <div className="flex items-center justify-between border-b-2 border-foreground px-5 py-3">
            <p className="text-sm font-black uppercase tracking-widest">
              OpenCode
            </p>
            <a
              href={props.sandbox.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-bold underline decoration-2 underline-offset-4"
            >
              New tab →
            </a>
          </div>
          <iframe
            title={`${props.sandbox.repoName} OpenCode workspace`}
            src={props.sandbox.previewUrl}
            className="h-[78vh] w-full bg-background"
          />
        </div>
      ) : (
        <div className="flex min-h-[420px] items-center justify-center p-12 text-center">
          <div className="max-w-md">
            <h3 className="text-2xl font-black uppercase">
              {props.sandbox.status === 'failed'
                ? 'Workspace failed.'
                : 'Booting workspace...'}
            </h3>
            <p className="mt-4 text-sm text-muted-foreground">
              {props.sandbox.errorMessage ||
                'The embedded preview will appear here once OpenCode is reachable. Try restarting if stuck.'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
