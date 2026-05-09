'use client';

import { Button } from '@/components/ui/button';
import { useLogin, usePrivy } from '@privy-io/react-auth';
import { ArrowRightIcon, CoinsIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export default function HomePage() {
  const { authenticated, ready, logout, user } = usePrivy();
  const { login } = useLogin();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  useEffect(() => {
    if (!ready || !authenticated) return;
    const safe = sanitizeNextPath(next);
    if (safe) router.replace(safe);
  }, [ready, authenticated, next, router]);

  // Match AppNav's logout: await Privy's session teardown so the cookie is
  // actually gone, then clear any `?next=` from the URL so a subsequent sign
  // in doesn't bounce to a previously requested gated page.
  const onSignOut = async () => {
    await logout();
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
// param is missing or unsafe — caller stays on `/`.
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
