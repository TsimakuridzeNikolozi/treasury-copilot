'use client';

import { Button } from '@/components/ui/button';
import type { BootstrapResponse } from '@/lib/api-types';
import { useLogin, usePrivy } from '@privy-io/react-auth';
import {
  ArrowRightIcon,
  CoinsIcon,
  Loader2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

type BootstrapState =
  | { kind: 'idle' }
  | { kind: 'in_flight'; created: boolean }
  | { kind: 'error'; status: number; message: string };

// `useSearchParams()` forces a CSR bailout in Next 15 — to avoid a
// build-time error the read must sit inside a Suspense boundary. We
// keep the Suspense thin (just the inner page body) so the static
// chrome above it still prerenders.
export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomePageInner />
    </Suspense>
  );
}

function HomePageInner() {
  const { authenticated, ready, logout, user } = usePrivy();
  const { login } = useLogin();
  const { getAccessToken } = usePrivy();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  const [bootstrap, setBootstrap] = useState<BootstrapState>({ kind: 'idle' });
  // useRef instead of state so React 18 strict-mode's effect double-fire
  // doesn't fire two simultaneous bootstrap requests in dev.
  const inFlightRef = useRef(false);

  // Drive the bootstrap when authentication settles. We POST through to
  // /api/me/bootstrap once per session; the route is idempotent (the
  // session-scoped advisory lock + post-lock count check make duplicate
  // requests a no-op), but firing it just once keeps logs and Privy
  // rate limits clean.
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // Two distinct flows hit this effect:
    //   1. Fresh signup / deep-link bounce — Privy redirected here and
    //      we want to forward the user onward (to `next` if set, or
    //      `/chat` for new accounts).
    //   2. Returning user manually clicking the home logo — they want
    //      to *be* on `/` and see the SignedInPanel.
    // We tell them apart by `(a)` whether `?next=...` was set on the URL
    // (middleware bounces), or `(b)` whether bootstrap actually created
    // something this call (first signup). Otherwise: stay put.
    const safeNext = sanitizeNextPath(next);

    // Optimistic: assume created=false (no spinner copy). The route
    // returns quickly when memberships already exist; we flip the
    // descriptive copy on once we see created=true. 200ms delay so the
    // spinner doesn't flash during instant short-circuits.
    let copyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      setBootstrap({ kind: 'in_flight', created: true });
    }, 200);

    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch('/api/me/bootstrap', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (copyTimer) {
          clearTimeout(copyTimer);
          copyTimer = null;
        }
        if (!res.ok) {
          const text = await res.text();
          setBootstrap({
            kind: 'error',
            status: res.status,
            message: text || `${res.status} ${res.statusText}`,
          });
          inFlightRef.current = false;
          return;
        }
        const body = (await res.json()) as BootstrapResponse;
        const shouldRedirect = body.created || safeNext !== null;
        if (shouldRedirect) {
          // First-timer's spinner stays up across the redirect.
          // router.replace (not push) so they can't back-button into it.
          if (body.created) setBootstrap({ kind: 'in_flight', created: true });
          router.replace(safeNext ?? '/chat');
        } else {
          // Returning user, manual visit — show the SignedInPanel and
          // let them choose where to go.
          setBootstrap({ kind: 'idle' });
        }
      } catch (err) {
        if (copyTimer) {
          clearTimeout(copyTimer);
          copyTimer = null;
        }
        setBootstrap({
          kind: 'error',
          status: 0,
          message: err instanceof Error ? err.message : String(err),
        });
        inFlightRef.current = false;
      }
    })();

    return () => {
      if (copyTimer) clearTimeout(copyTimer);
    };
  }, [ready, authenticated, next, getAccessToken, router]);

  const onRetry = () => {
    inFlightRef.current = false;
    setBootstrap({ kind: 'idle' });
  };

  // Sign-out: clear our active-treasury cookie in parallel with Privy's
  // session teardown so the next user on a shared browser doesn't
  // inherit the previous user's selection.
  const onSignOut = async () => {
    await Promise.allSettled([logout(), fetch('/api/auth/logout', { method: 'POST' })]);
    router.replace('/');
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-10 px-6 py-16">
      {/* Subtle radial backdrop — gives the empty page a sense of depth without
          stealing attention from the call-to-action. */}
      <div
        aria-hidden
        className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-muted)_0%,transparent_60%)]"
      />

      <div className="flex flex-col items-center gap-3 text-center">
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl border bg-card shadow-sm"
        >
          <CoinsIcon className="size-6" />
        </div>
        <h1 className="font-semibold text-4xl tracking-tight sm:text-5xl">Treasury Copilot</h1>
        <p className="max-w-md text-balance text-muted-foreground">
          Chat-first AI agent that manages USDC across Solana yield venues — under hard policy
          guardrails.
        </p>
      </div>

      {!ready ? (
        <LoadingShell />
      ) : authenticated && bootstrap.kind === 'in_flight' ? (
        <BootstrappingPanel created={bootstrap.created} />
      ) : authenticated && bootstrap.kind === 'error' ? (
        <BootstrapErrorPanel state={bootstrap} onRetry={onRetry} onSignOut={onSignOut} />
      ) : authenticated ? (
        <SignedInPanel
          email={user?.email?.address ?? null}
          did={user?.id ?? null}
          onSignOut={onSignOut}
        />
      ) : (
        <SignInPanel onSignIn={() => login()} />
      )}

      <FeatureRow />
    </main>
  );
}

function LoadingShell() {
  return (
    <div className="flex flex-col items-center gap-3" aria-live="polite" aria-busy>
      <div className="h-10 w-40 animate-pulse rounded-md bg-muted" />
      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      <span className="sr-only">Loading authentication state</span>
    </div>
  );
}

function SignInPanel({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <Button size="lg" onClick={onSignIn} className="gap-2">
        Sign in with email
        <ArrowRightIcon className="size-4" aria-hidden />
      </Button>
      <p className="text-muted-foreground text-xs">
        Email OTP via Privy. No password, no wallet linking required.
      </p>
    </div>
  );
}

function BootstrappingPanel({ created }: { created: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center" aria-live="polite" aria-busy>
      <Loader2Icon className="size-8 animate-spin text-muted-foreground" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-sm">Setting up your treasury…</p>
        {created && (
          <p className="max-w-xs text-muted-foreground text-xs">
            This takes a few seconds — we're creating a hardware-secured wallet for you.
          </p>
        )}
      </div>
    </div>
  );
}

function BootstrapErrorPanel({
  state,
  onRetry,
  onSignOut,
}: {
  state: { kind: 'error'; status: number; message: string };
  onRetry: () => void;
  onSignOut: () => void;
}) {
  // 502 is Turnkey-unavailable territory; surface the raw message so an
  // operator chasing a staging outage gets the signal in the browser
  // console / a11y reader. Anything else: generic copy.
  const detail =
    state.status === 502
      ? state.message
      : 'We hit a snag setting up your treasury. Please try again.';
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-destructive text-sm">{detail}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
        <Button size="sm" variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function SignedInPanel({
  email,
  did,
  onSignOut,
}: {
  email: string | null;
  did: string | null;
  onSignOut: () => void;
}) {
  const label = email ?? (did ? `…${did.slice(-12)}` : 'guest');
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-muted-foreground text-sm">
        Signed in as <span className="font-mono text-foreground">{label}</span>
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg" className="gap-2">
          <Link href="/chat">
            Open chat
            <ArrowRightIcon className="size-4" aria-hidden />
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/settings">Policy &amp; settings</Link>
        </Button>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        className="rounded text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Sign out
      </button>
    </div>
  );
}

function FeatureRow() {
  return (
    <div className="grid w-full max-w-2xl grid-cols-1 gap-3 pt-6 sm:grid-cols-3">
      <Feature
        icon={<SparklesIcon className="size-4" aria-hidden />}
        title="Chat-first"
        body="Move USDC by asking. Every action is proposed, evaluated, and audited."
      />
      <Feature
        icon={<ShieldCheckIcon className="size-4" aria-hidden />}
        title="Policy-gated"
        body="Caps, allowlist, and approval thresholds enforced at proposal time."
      />
      <Feature
        icon={<CoinsIcon className="size-4" aria-hidden />}
        title="Kamino + Save"
        body="Deposit, withdraw, rebalance. Drift &amp; Marginfi land in M2."
      />
    </div>
  );
}

// Open-redirect guard: middleware sets `?next=<path>` on bounces and only
// ever stores app-internal paths there, but the param is attacker-influenced
// (anyone can craft a `/?next=https://evil.com` link). router.replace will
// happily navigate off-origin if handed an absolute URL, so reject anything
// that doesn't look like a same-origin relative path. Returns null when the
// param is missing or unsafe — caller falls back to /chat.
function sanitizeNextPath(next: string | null): string | null {
  if (!next) return null;
  // Must start with `/` (relative) but not `//` (protocol-relative URLs like
  // `//evil.com/x` would resolve cross-origin).
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  // Catches `/\evil.com` and other backslash tricks some browsers normalise
  // into a host-prefixed URL.
  if (next.includes('\\')) return null;
  // Defensive: if URL parses with a non-empty protocol/host, refuse.
  try {
    const parsed = new URL(next, 'http://placeholder.invalid');
    if (parsed.host !== 'placeholder.invalid') return null;
  } catch {
    return null;
  }
  return next;
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-foreground">
        <span className="flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
          {icon}
        </span>
        <span className="font-medium text-sm">{title}</span>
      </div>
      <p className="mt-2 text-muted-foreground text-xs leading-relaxed">{body}</p>
    </div>
  );
}
