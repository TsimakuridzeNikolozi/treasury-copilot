'use client';

import { type VariantProps, cva } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// IconButton is a separate primitive from <Button> so the existing shadcn
// Button stays untouched. Icon-only triggers in the chat sidebar header,
// action card top-right, and the theme toggle share this shape: small
// square with hover-bg `--muted` and the design's muted-foreground default.
const iconButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      size: {
        sm: 'size-7',
        md: 'size-8',
        lg: 'size-9',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

type Props = ComponentProps<'button'> &
  VariantProps<typeof iconButtonVariants> & {
    asChild?: boolean;
  };

export function IconButton({ className, size, asChild = false, ...props }: Props) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      type={asChild ? undefined : 'button'}
      data-slot="icon-button"
      className={cn(iconButtonVariants({ size, className }))}
      {...props}
    />
  );
}
