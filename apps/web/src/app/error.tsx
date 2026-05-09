'use client';

import { Button } from '@/components/ui/button';
import { AlertTriangleIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[error.tsx]', error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <div
        aria-hidden
        className="flex size-12 items-center justify-center rounded-xl border bg-card text-destructive"
      >
        <AlertTriangleIcon className="size-6" />
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="flex flex-col gap-2">
        <h1 className="font-semibold text-3xl tracking-tight">Something broke</h1>
        <p className="max-w-md text-balance text-muted-foreground text-sm">
          An unexpected error happened while rendering this page. The trust boundary still holds —
          no funds move without an explicit policy decision.
        </p>
        {error.digest && (
          <p className="text-muted-foreground text-xs">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </main>
  );
}
