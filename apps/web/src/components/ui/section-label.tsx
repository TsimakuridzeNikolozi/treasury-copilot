import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// Small uppercase tracking label used above section headers and inside cards
// ("Treasury", "Positions", "Wallet address"). Sized at 10px so the label
// reads as metadata, not content. Tailwind doesn't ship 0.625rem out of the
// box — we use the [10px] arbitrary value.
export function SectionLabel({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
