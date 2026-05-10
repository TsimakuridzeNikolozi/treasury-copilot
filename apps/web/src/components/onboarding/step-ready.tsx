'use client';

import { Button } from '@/components/ui/button';
import { usePrivy } from '@privy-io/react-auth';
import { ArrowRightIcon, CoinsIcon, Loader2Icon, SparklesIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Step 5 — Ready / try-asking primer.
//
// Three example prompts that map to chat-client.tsx's SUGGESTIONS list
// (kept in sync visually so the user sees the same shape on /chat).
//
// "Open chat" awaits the POST /api/me/onboarded — we explicitly DON'T
// silently swallow errors and redirect anyway (PR 5 review fix #17): a
// failed POST leaves `onboarded_at = null`, which would bounce the user
// right back into the wizard. Inline retry is honest about that.

const SUGGESTIONS: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: 'Show my positions', prompt: 'Show my positions across all venues.' },
  { title: 'Compare APYs', prompt: 'Compare the current supply APY for USDC on Kamino vs Save.' },
  { title: 'Rebalance 0.5 USDC', prompt: 'Rebalance 0.5 USDC from Save to Kamino.' },
];

export function StepReady() {
  const { getAccessToken } = usePrivy();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/me/onboarded', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      // Successful POST. router.replace (not push) so the back button
      // doesn't return them to the wizard.
      router.replace('/chat');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-6 rounded-xl border bg-card p-6 sm:gap-8 sm:p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl border bg-muted text-primary"
        >
          <SparklesIcon className="size-6" />
        </div>
        <h2 className="font-semibold text-2xl tracking-tight">You're ready</h2>
        <p className="mx-auto max-w-md text-balance text-muted-foreground text-sm">
          Treasury Copilot is set up. Try asking it something.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <li
            key={s.title}
            className="flex items-start gap-3 rounded-lg border bg-muted/30 px-3 py-2.5"
          >
            <CoinsIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-sm">{s.title}</span>
              <span className="font-mono text-muted-foreground text-xs">{s.prompt}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-end gap-3">
        {error && (
          <span className="max-w-[20rem] truncate text-destructive text-xs" title={error}>
            {error}
          </span>
        )}
        <Button size="lg" onClick={finish} disabled={saving} className="gap-2">
          {saving ? (
            <>
              <Loader2Icon className="size-4 animate-spin" aria-hidden />
              Opening chat
            </>
          ) : (
            <>
              Open chat
              <ArrowRightIcon className="size-4" aria-hidden />
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
