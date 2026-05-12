'use client';

import { cn } from '@/lib/utils';
import { CheckIcon } from 'lucide-react';

const STEPS = [
  { n: 1, title: 'Welcome' },
  { n: 2, title: 'Fund' },
  { n: 3, title: 'Guardrails' },
  { n: 4, title: 'Telegram' },
  { n: 5, title: 'Ready' },
] as const;

// Pill row + connector lines. Each pill carries a number glyph + step
// title. The active pill gets a muted background with a 1px ring; done
// gets the cyan check glyph + muted text; future stays ring-only. On
// mobile, titles collapse to icon-only so the row fits a 360px viewport.
//
// Interactive: clicking a *completed* pill jumps back to that step. We
// intentionally don't let users jump *forward* past their saved step —
// onboarding has state-mutating side effects (bootstrap, balance poll
// kickoff) that need to happen in order.
export function StepIndicator({
  current,
  onJump,
}: {
  current: number;
  onJump: (step: number) => void;
}) {
  return (
    <ol aria-label="Onboarding progress" className="flex w-full items-center gap-1.5">
      {STEPS.map((s, i) => {
        const state = s.n < current ? 'done' : s.n === current ? 'current' : 'future';
        const isLast = i === STEPS.length - 1;
        const clickable = state === 'done';
        return (
          <li key={s.n} className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={clickable ? () => onJump(s.n) : undefined}
              disabled={!clickable}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 transition-colors',
                state === 'current'
                  ? 'bg-muted text-foreground shadow-[inset_0_0_0_1px_var(--border)]'
                  : 'text-muted-foreground',
                clickable ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
              )}
            >
              <StepGlyph state={state} n={s.n} />
              <span className="hidden truncate font-medium text-xs sm:inline">{s.title}</span>
            </button>
            {!isLast ? (
              <span
                aria-hidden
                className={cn(
                  'h-px w-3 shrink-0',
                  s.n < current ? 'bg-primary opacity-60' : 'bg-border',
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StepGlyph({ state, n }: { state: 'done' | 'current' | 'future'; n: number }) {
  if (state === 'done') {
    return (
      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <CheckIcon className="size-2.5" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums',
        state === 'current'
          ? 'bg-foreground text-background'
          : 'text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]',
      )}
    >
      {n}
    </span>
  );
}
