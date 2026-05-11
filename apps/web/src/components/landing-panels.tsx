'use client';

import { Button } from '@/components/ui/button';
import { useLogin, usePrivy } from '@privy-io/react-auth';
import { ArrowRightIcon, CoinsIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Two client islands hosted on the otherwise-server-rendered "/" page.
// `SignInPanel` triggers Privy's email OTP flow; `SignedInPanel` is the
// returning-user landing card with sign-out + Open chat affordances.
//
// Why client: both depend on `@privy-io/react-auth` hooks (`useLogin`,
// `usePrivy.logout()`) which can only run in the browser. Everything
// else on the page is rendered on the server (auth gate, redirect to
// /onboarding for unfinished users, hero copy).

export function SignInPanel() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();

  // The server renders SignInPanel when the Privy access token is absent
  // or expired at SSR time. The client-side Privy SDK then initialises
  // and may silently refresh an expired token using the long-lived
  // refresh token. When that happens `authenticated` flips to true while
  // the page still shows SignInPanel — calling router.refresh() re-runs
  // the server component with the new cookie so the correct view is
  // shown without requiring any user interaction.
  // This also covers the case where login() is a no-op because the user
  // is already authenticated (expired token, fresh refresh) and onComplete
  // never fires.
  useEffect(() => {
    if (ready && authenticated) router.refresh();
  }, [ready, authenticated, router]);

  // Privy sets its session cookie client-side after the OTP modal closes.
  // `router.refresh()` re-runs the server component with the fresh cookie,
  // which then redirects to /onboarding (or renders SignedInPanel).
  const { login } = useLogin({ onComplete: () => router.refresh() });
  return (
    <div className="flex flex-col items-center gap-3">
      <Button size="lg" onClick={() => login()} className="gap-2">
        Sign in with email
        <ArrowRightIcon className="size-4" aria-hidden />
      </Button>
      <p className="text-muted-foreground text-xs">
        Email OTP via Privy. No password, no wallet linking required.
      </p>
    </div>
  );
}

export function SignedInPanel({ email, did }: { email: string | null; did: string | null }) {
  const { logout } = usePrivy();
  const router = useRouter();
  // Sign-out: clear our active-treasury cookie in parallel with Privy's
  // session teardown so the next user on a shared browser doesn't
  // inherit the previous user's selection. Mirrors the chat/app-nav
  // behavior for consistency.
  const onSignOut = async () => {
    await Promise.allSettled([logout(), fetch('/api/auth/logout', { method: 'POST' })]);
    router.replace('/');
  };
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

export function FeatureRow() {
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
