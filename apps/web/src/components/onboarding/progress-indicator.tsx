'use client';

import { cn } from '@/lib/utils';

// Five-dot stepper. Active step gets `--primary`; completed steps get
// `--primary` at lower opacity; future steps stay neutral. Pure visual —
// no interactivity (steps advance via the wizard's CTAs, not clicks).
//
// `aria-label` on the wrapping <nav> keeps the structural semantics
// readable to assistive tech without making each dot individually
// focusable (it's a passive indicator, not a stepper control).
export function ProgressIndicator({ current, total }: { current: number; total: number }) {
  return (
    <nav aria-label="Onboarding progress" className="flex items-center justify-center gap-2">
      {Array.from({ length: total }, (_, i) => i + 1).map((step) => {
        const state = step < current ? 'done' : step === current ? 'active' : 'todo';
        return (
          <span
            key={step}
            aria-hidden
            // Specific transitioned properties (not `transition-all`) so
            // future style additions on these spans don't accidentally
            // animate, and so paint stays cheap. Width + background-color
            // are the only things that change between states.
            className={cn(
              'h-1.5 rounded-full transition-[width,background-color] duration-200 ease-out',
              state === 'active' ? 'w-8 bg-primary' : 'w-1.5',
              state === 'done' && 'bg-primary/40',
              state === 'todo' && 'bg-muted-foreground/30',
            )}
          />
        );
      })}
      <span className="sr-only">
        Step {current} of {total}
      </span>
    </nav>
  );
}
