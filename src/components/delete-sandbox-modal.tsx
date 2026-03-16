import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

const CONFIRM_TEXT = 'CONTINUE'

type DeleteSandboxModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
  sandboxName?: string
}

export function DeleteSandboxModal({
  open,
  onOpenChange,
  onConfirm,
  sandboxName,
}: DeleteSandboxModalProps) {
  const [confirmInput, setConfirmInput] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  const isConfirmEnabled = confirmInput === CONFIRM_TEXT

  function handleClose(open: boolean) {
    if (!open) {
      setConfirmInput('')
    }
    onOpenChange(open)
  }

  async function handleConfirm() {
    if (!isConfirmEnabled || isDeleting) return

    setIsDeleting(true)
    try {
      await onConfirm()
      handleClose(false)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-black uppercase">
            Destroy sandbox?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p className="font-bold text-destructive">
                You are going to destroy all your changes.
              </p>
              <p className="text-muted-foreground">
                This workspace will be permanently deleted. Any uncommitted code,
                local changes, and environment data will be lost. This action
                cannot be undone.
              </p>
              {sandboxName ? (
                <p className="font-mono text-foreground">
                  Workspace: <strong>{sandboxName}</strong>
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Type <strong className="font-mono text-foreground">{CONFIRM_TEXT}</strong> below to
                confirm.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label
            htmlFor="delete-confirm-input"
            className="text-[10px] font-black uppercase tracking-widest text-muted-foreground"
          >
            Type {CONFIRM_TEXT} to continue
          </label>
          <Input
            id="delete-confirm-input"
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder={CONFIRM_TEXT}
            className="border-2 border-foreground font-mono shadow-[2px_2px_0_var(--foreground)] focus-visible:shadow-none"
            autoComplete="off"
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={isDeleting}
            className="border-2 border-foreground font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={!isConfirmEnabled || isDeleting}
            className="border-2 border-foreground font-black uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none disabled:opacity-50"
          >
            {isDeleting ? 'Deleting...' : 'Destroy sandbox'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
