'use client';

import { TCLogo, TCMark } from '@/components/brand/tc-logo';
import { TreasurySwitcher } from '@/components/treasury-switcher';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { UserMenu } from '@/components/user-menu';
import Link from 'next/link';
import type { ReactNode } from 'react';

interface Props {
  activeTreasuryId?: string;
  // Last segment of the breadcrumb — rendered after the logo (e.g.
  // "Settings", "History"). Left as a plain string so callers don't
  // have to import a special crumb component.
  breadcrumb: string;
  // Whether to render a back-to-chat button on the right side. Used on
  // /settings to give a single-click route back to work.
  showBackToChat?: boolean;
  children: ReactNode;
}

// AppShell wraps the authenticated, treasury-bound surfaces other than
// /chat (which owns its own sidebar layout). Top-only chrome with logo +
// breadcrumb on the left, treasury switcher + theme + account on the
// right. Sticky so the chrome stays available during long scrolls
// (history pagination, settings forms).
export function AppShell({ activeTreasuryId, breadcrumb, showBackToChat, children }: Props) {
  return (
    // min-h-screen so the wrapper has a clear height baseline on mobile
    // (body has no explicit height, so min-h-full resolves to 0).
    // overflow-x-hidden is intentionally absent here: setting it would
    // force overflow-y to auto (CSS spec), making this div a scroll
    // container and intercepting position:sticky's scroll ancestor
    // lookup before it can reach <html>/<body> where the viewport
    // scroll actually lives. Horizontal overflow is already clipped at
    // the body level via globals.css.
    <div className="flex min-h-screen w-full flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/60">
        <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link
              href="/chat"
              aria-label="Treasury Copilot home"
              className="flex shrink-0 items-center"
            >
              {/* Mobile collapses to monogram-only so the breadcrumb has room. */}
              <span className="hidden sm:inline-flex">
                <TCLogo size={18} />
              </span>
              <span className="sm:hidden">
                <TCMark size={18} />
              </span>
            </Link>
            <span className="text-border" aria-hidden>
              /
            </span>
            <span className="truncate text-muted-foreground text-sm">{breadcrumb}</span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <TreasurySwitcher activeTreasuryId={activeTreasuryId} />
            <ThemeToggle />
            <UserMenu />
            {showBackToChat ? (
              <Link
                href="/chat"
                className="ml-1 hidden rounded-md px-2 text-muted-foreground text-xs hover:text-foreground sm:inline"
              >
                Back to chat
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
