'use client';

import type { WizardTreasury } from '@/app/onboarding/onboarding-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { CheckIcon, CopyIcon, Loader2Icon } from 'lucide-react';
import QRCode from 'qrcode-svg';
import { useEffect, useMemo, useRef, useState } from 'react';

// Step 2 — Fund wallet.
//
// Wallet address (copy + QR) plus a 5s balance poll against
// /api/treasury/balance. The balance line surfaces "✓ {N} USDC" once
// USDC is detected; manual "I've funded it" advances regardless. Skip
// also advances — the wizard is non-blocking on funding (users may want
// to fund from a CEX which takes minutes; we don't pin them here).
//
// Polling backoff (matches the API route's 3s server-side cache TTL):
//   - 5s base interval.
//   - On 429/5xx: pause 30s before next attempt.
//   - On 3 consecutive errors: pause 60s.
//   - Effect cleanup on unmount stops the poll cleanly so the parent
//     can advance without leaking a fetch.

const POLL_INTERVAL_MS = 5_000;
const BACKOFF_AFTER_ERROR_MS = 30_000;
const HARD_BACKOFF_MS = 60_000;

interface PollState {
  amountUsdc: string | null;
  errorCount: number;
}

export function StepFundWallet({
  treasury,
  onAdvance,
}: {
  treasury: WizardTreasury;
  onAdvance: () => void;
}) {
  const [poll, setPoll] = useState<PollState>({ amountUsdc: null, errorCount: 0 });
  const [copied, setCopied] = useState(false);
  // Stable ref for the latest poll state so the effect's loop reads
  // current errorCount without restarting on every state change.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  // Privy's session is the bearer source. The balance route uses
  // `verifyBearer` (Authorization header), not Privy's cookie — same
  // pattern as chat-client. Held in a ref so the polling effect's
  // closure reads the latest token without restarting on each render.
  const { getAccessToken } = usePrivy();
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  // QR code rendered as a clean React SVG. qrcode-svg generates a
  // joined-path SVG string; we extract just the `d` attribute and the
  // `viewBox`-derived size, then render a real <svg><path/></svg>
  // element so React owns the tree (no dangerouslySetInnerHTML, no
  // sanitization concerns even though the input is safe base58).
  const qrPath = useMemo(() => {
    const svgString = new QRCode({
      content: treasury.walletAddress,
      width: 160,
      height: 160,
      padding: 0,
      color: 'currentColor',
      background: 'transparent',
      ecl: 'M',
      join: true,
    }).svg();
    // Extract the single joined path. qrcode-svg with `join: true`
    // emits exactly one <path d="..."/>; the regex tolerates either
    // `d="..."` or `d='...'`. Fall back to empty string if absent
    // (would render an empty box — acceptable degradation).
    const match = svgString.match(/<path[^>]*d="([^"]+)"/);
    return match?.[1] ?? '';
  }, [treasury.walletAddress]);

  // Polling loop. setTimeout chained so backoff is straightforward —
  // setInterval would force a separate "skip if last fired during
  // backoff" check. Cleanup clears any pending timer on unmount or
  // step change.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Default to base interval; overridden in the catch path below.
      let nextWait = POLL_INTERVAL_MS;
      try {
        const token = await getAccessTokenRef.current();
        if (cancelled) return;
        const url = `/api/treasury/balance?treasuryId=${encodeURIComponent(treasury.id)}`;
        const res = await fetch(url, {
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (cancelled) return;

        if (res.status === 409) {
          // Active treasury moved — full reload picks up the new id.
          window.location.reload();
          return;
        }
        if (!res.ok) {
          throw new Error(`${res.status}`);
        }

        const body = (await res.json()) as { amountUsdc: string };
        setPoll({ amountUsdc: body.amountUsdc, errorCount: 0 });
      } catch {
        // Read the count from the ref (last-render snapshot) BEFORE
        // calling setPoll — React won't update the ref until the next
        // render, so reading it after setPoll would give the stale
        // pre-error count and schedule the wrong interval.
        const newCount = pollRef.current.errorCount + 1;
        setPoll((cur) => ({ amountUsdc: cur.amountUsdc, errorCount: newCount }));
        nextWait = newCount >= 3 ? HARD_BACKOFF_MS : BACKOFF_AFTER_ERROR_MS;
      }

      if (cancelled) return;
      timer = setTimeout(tick, nextWait);
    };

    // Kick off immediately so the user sees the balance on mount.
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [treasury.id]);

  // Copy-pulse — mirrors WalletAddressBlock.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(treasury.walletAddress);
      setCopied(true);
    } catch {
      // Insecure context — fall back to manual select. No recovery.
    }
  };

  const positiveBalance = poll.amountUsdc !== null && Number.parseFloat(poll.amountUsdc) > 0;

  return (
    <section className="flex flex-col gap-6 rounded-xl border bg-card p-6 sm:gap-8 sm:p-8">
      <header className="flex flex-col gap-2 text-center">
        <h2 className="font-semibold text-2xl tracking-tight">Fund your wallet</h2>
        <p className="mx-auto max-w-md text-balance text-muted-foreground text-sm">
          Send USDC on Solana to the address below. We'll detect it automatically — or click "I've
          funded it" when you're done.
        </p>
      </header>

      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-center sm:gap-6">
        {/* Wrapper is a presentational box, NOT aria-hidden — the inner
            <svg role="img" aria-label> announces "QR code of treasury
            wallet address" to assistive tech. Hiding the wrapper would
            also hide the SVG and its label, defeating the point. */}
        <div className="flex size-40 shrink-0 items-center justify-center rounded-lg border bg-background p-3 text-foreground">
          <svg
            viewBox="0 0 160 160"
            xmlns="http://www.w3.org/2000/svg"
            className="size-full"
            role="img"
            aria-label="QR code of treasury wallet address"
          >
            <path d={qrPath} fill="currentColor" />
          </svg>
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
              Treasury wallet
            </p>
            <div className="flex items-center gap-2">
              <code className="break-all font-mono text-sm">{treasury.walletAddress}</code>
              <button
                type="button"
                onClick={onCopy}
                aria-label="Copy wallet address"
                className="-m-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {copied ? (
                  <CheckIcon
                    className="size-4 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                ) : (
                  <CopyIcon className="size-4" aria-hidden />
                )}
              </button>
            </div>
          </div>
          <output
            aria-live="polite"
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 font-mono text-sm tabular-nums',
              positiveBalance
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400'
                : 'bg-muted/30 text-muted-foreground',
            )}
          >
            {poll.amountUsdc === null ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                <span>Checking balance…</span>
              </>
            ) : positiveBalance ? (
              <>
                <CheckIcon className="size-3.5" aria-hidden />
                <span>{poll.amountUsdc} USDC</span>
              </>
            ) : (
              <span>Balance: 0 USDC</span>
            )}
          </output>
          <p className="text-muted-foreground text-xs">
            A small SOL balance (~0.05 SOL) is also needed for transaction fees.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button type="button" variant="outline" onClick={onAdvance}>
          Skip for now
        </Button>
        <Button type="button" onClick={onAdvance}>
          I've funded it
        </Button>
      </div>
    </section>
  );
}
