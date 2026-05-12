import { type VariantProps, cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// Chip is the design's small pill — used for status, network, telegram
// connectivity, and various inline tags. Kept parallel to the existing
// shadcn <Badge> so older surfaces don't have to migrate at once; new
// surfaces use Chip for the design's exact tone palette.
const chipVariants = cva(
  'inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[11px] font-medium tracking-tight whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        primary: 'bg-primary-soft text-primary-soft-foreground',
        // Solid cyan — used by StatusChip for the "executed" terminal state.
        // Reads as success without leaning on the green semantics other
        // surfaces use for confirmation, keeping the cyan accent single-tone.
        primarySolid: 'bg-primary text-primary-foreground',
        destructive: 'bg-[color-mix(in_oklch,var(--destructive)_18%,var(--card))] text-destructive',
        outline: 'bg-transparent text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

type Props = ComponentProps<'span'> &
  VariantProps<typeof chipVariants> & {
    // Optional 6px leading dot — used to indicate connectivity / liveness.
    dot?: boolean;
  };

export function Chip({ className, tone, dot = false, children, ...props }: Props) {
  return (
    <span data-slot="chip" className={cn(chipVariants({ tone, className }))} {...props}>
      {dot ? <span aria-hidden className="inline-block size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
