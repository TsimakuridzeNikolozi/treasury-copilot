import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// Inline mono wrapper for tabular numbers, addresses, tx signatures, and
// timestamps. Pairs JetBrains Mono (via --font-mono) with `tabular-nums` so
// columns of figures align. Default element is <span>; pass `as` only if
// you need block-level semantics — for inline numbers, <span> is right.
export function Mono({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('font-mono tabular-nums', className)} {...props} />;
}
