import { Link } from '@tanstack/react-router'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

export function SandboxMissingState() {
  return (
    <Card className="border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]">
      <CardHeader>
        <CardTitle className="text-2xl font-black uppercase">
          Workspace missing
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          This sandbox no longer exists or you don&apos;t have access.
        </p>
      </CardHeader>
      <CardContent>
        <Button
          asChild
          className="border-2 border-foreground bg-foreground font-black uppercase text-background shadow-[3px_3px_0_var(--accent)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
        >
          <Link to="/dashboard">← Back to dashboard</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
