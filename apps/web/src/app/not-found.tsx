import { Button } from '@/components/ui/button';
import { CompassIcon } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <div
        aria-hidden
        className="flex size-12 items-center justify-center rounded-xl border bg-card text-muted-foreground"
      >
        <CompassIcon className="size-6" />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="font-semibold text-3xl tracking-tight">Page not found</h1>
        <p className="max-w-md text-balance text-muted-foreground text-sm">
          That route doesn&rsquo;t exist. It may have been moved, or the link you followed is out of
          date.
        </p>
      </div>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/">Go home</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/chat">Open chat</Link>
        </Button>
      </div>
    </main>
  );
}
