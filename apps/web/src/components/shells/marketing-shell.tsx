'use client';

import { TCLogo } from '@/components/brand/tc-logo';
import { Mono } from '@/components/ui/mono';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { ReactNode } from 'react';

// Marketing-shell wraps the unauthenticated + landing surfaces. Minimal
// chrome: logo + a couple of marketing links + the theme toggle. The
// footer carries copyright + a network badge so the user can verify they
// landed on the right chain at a glance.
export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      <header className="flex items-center justify-between border-b px-5 py-4 sm:px-8 sm:py-5">
        <TCLogo size={20} />
        <nav
          className="hidden items-center gap-5 text-sm text-muted-foreground sm:flex"
          aria-label="External"
        >
          <a
            href="https://github.com/TsimakuridzeNikolozi"
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground"
          >
            GitHub
          </a>
        </nav>
        <ThemeToggle />
      </header>

      <main className="flex flex-1 flex-col">{children}</main>

      <footer className="flex items-center justify-between border-t px-5 py-5 text-muted-foreground text-xs sm:px-8 sm:py-6">
        <span>© 2026 Treasury Copilot</span>
        <Mono className="text-[11px]">solana mainnet</Mono>
      </footer>
    </div>
  );
}
