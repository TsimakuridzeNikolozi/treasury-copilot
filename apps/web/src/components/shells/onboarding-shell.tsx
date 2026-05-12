'use client';

import { TCLogo } from '@/components/brand/tc-logo';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { ReactNode } from 'react';

// Onboarding has no nav and no treasury switcher — the user has no
// treasury yet on step 1, and even after they've created one we don't
// want to expose ways to navigate away mid-setup. Just the logo on the
// left, an Exit setup link + theme toggle on the right.
export function OnboardingShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      <header className="flex items-center justify-between border-b px-5 py-4 sm:px-8 sm:py-5">
        <TCLogo size={20} />
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-start justify-center overflow-auto px-5 py-8 sm:px-8 sm:py-12">
        {children}
      </main>
    </div>
  );
}
