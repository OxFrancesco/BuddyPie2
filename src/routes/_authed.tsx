import { SignIn, UserButton } from '@clerk/tanstack-react-start'
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from '@tanstack/react-router'

export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context }) => {
    if (!context.userId) {
      throw new Error('Not authenticated')
    }
  },
  errorComponent: ({ error }) => {
    const location = useLocation()

    if (error.message === 'Not authenticated') {
      return (
        <div className="fixed inset-0 flex items-center justify-center p-6 sm:p-8 md:p-12">
          <SignIn
            routing="hash"
            forceRedirectUrl={location.href}
            appearance={{
              elements: {
                rootBox: 'mx-auto w-full max-w-md',
                card: 'border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]',
                footer: { display: 'none' },
                footerAction: { display: 'none' },
              },
            }}
          />
        </div>
      )
    }

    throw error
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  return (
    <div className="min-h-screen">
      <header className="border-b-2 border-foreground bg-card px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-lg font-black uppercase tracking-wider"
          >
            <img
              src="/logo.svg"
              alt="BuddyPie"
              className="h-8 w-auto"
            />
            <span>BuddyPie</span>
          </Link>
          <div className="flex shrink-0 items-center gap-4">
            <Link
              to="/profile"
              className="text-xs font-black uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"
            >
              Profile
            </Link>
            <UserButton
              appearance={{
                elements: {
                  userButtonBox: 'flex items-center rounded-full',
                  userButtonTrigger:
                    'rounded-full overflow-hidden border-2 border-foreground shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none transition-all',
                  userButtonPopoverFooter: { display: 'none' },
                  userButtonPopoverFooterPages: { display: 'none' },
                  userButtonPopoverAction: { display: 'none' },
                },
              }}
              userProfileProps={{
                appearance: {
                  elements: {
                    rootBox: 'border-2 border-foreground shadow-[4px_4px_0_var(--foreground)]',
                    card: 'border-2 border-foreground',
                    navbar: 'border-b-2 border-foreground',
                    pageScrollBox: 'border-0',
                    footer: { display: 'none' },
                    footerAction: { display: 'none' },
                    formButtonPrimary:
                      'border-2 border-foreground bg-foreground text-background font-black uppercase tracking-wider shadow-[4px_4px_0_var(--foreground)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none',
                    formButtonReset:
                      'border-2 border-foreground font-bold uppercase shadow-[2px_2px_0_var(--foreground)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-none',
                  },
                },
                additionalOAuthScopes: {
                  github: ['repo'],
                },
              }}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </div>
    </div>
  )
}
