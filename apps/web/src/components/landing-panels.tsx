'use client';

import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Mono } from '@/components/ui/mono';
import { SectionLabel } from '@/components/ui/section-label';
import { useLogin, usePrivy } from '@privy-io/react-auth';
import { ArrowRightIcon, ArrowUpRightIcon, LogOutIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Two client islands hosted on the otherwise-server-rendered "/" page.
// `SignInPanel` triggers Privy's email OTP flow; `SignedInPanel` is the
// returning-user landing card with sign-out + Open chat affordances.

export function SignInPanel() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();

  // The server renders SignInPanel when the Privy access token is absent
  // or expired at SSR time. The client-side Privy SDK then initialises
  // and may silently refresh an expired token. When `authenticated` flips
  // to true while the page still shows SignInPanel, router.refresh()
  // re-runs the server component with the new cookie.
  useEffect(() => {
    if (ready && authenticated) router.refresh();
  }, [ready, authenticated, router]);

  const { login } = useLogin({ onComplete: () => router.refresh() });

  return (
    <div
      className="flex flex-col gap-6 rounded-lg p-6 shadow-[inset_0_0_0_1px_var(--border)] sm:p-8"
      style={{ backgroundColor: 'var(--card)' }}
    >
      <div className="flex items-center justify-between">
        <SectionLabel>Sign in</SectionLabel>
        <Chip tone="outline">Email OTP</Chip>
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold text-2xl tracking-tight">Pick up where you left off.</h2>
        <p className="text-muted-foreground text-sm">
          One-tap email login via Privy — no password, no wallet linking.
        </p>
      </div>
      <Button onClick={() => login()} className="w-full gap-2" size="lg">
        Sign in with email
        <ArrowRightIcon className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

interface SignedInPanelProps {
  email: string | null;
  did: string | null;
  telegramConnected: boolean;
}

export function SignedInPanel({ email, did, telegramConnected }: SignedInPanelProps) {
  const { logout } = usePrivy();
  const router = useRouter();

  const onSignOut = async () => {
    await Promise.allSettled([logout(), fetch('/api/auth/logout', { method: 'POST' })]);
    router.replace('/');
  };

  const label = email ?? (did ? `…${did.slice(-12)}` : 'guest');

  return (
    <div
      className="flex flex-col gap-5 rounded-lg p-6 shadow-[inset_0_0_0_1px_var(--border)]"
      style={{ backgroundColor: 'var(--card)' }}
    >
      <div className="flex items-center justify-between">
        <SectionLabel>Signed in</SectionLabel>
        {telegramConnected ? (
          <Chip tone="primary" dot>
            Connected
          </Chip>
        ) : (
          <Chip tone="outline">Telegram off</Chip>
        )}
      </div>

      <Mono className="block truncate text-sm text-foreground">{label}</Mono>

      <div className="flex flex-col gap-2">
        <Button asChild className="gap-2" size="lg">
          <Link href="/chat">
            Open chat
            <ArrowRightIcon className="size-4" aria-hidden />
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="gap-2">
          <Link href="/settings">
            <SettingsIcon className="size-4" aria-hidden />
            Policy &amp; settings
          </Link>
        </Button>
      </div>

      <div className="flex items-center justify-between border-t pt-4 text-muted-foreground text-xs">
        <span>Solana mainnet · live</span>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1 rounded hover:text-foreground"
        >
          <LogOutIcon className="size-3" aria-hidden />
          Sign out
        </button>
      </div>
    </div>
  );
}

interface HeroStatsProps {
  underManagementUsdc: string;
  blendedApyPct: string | null;
  actionsAuditedCount: number;
}

// The hero's 3-up stats strip. Numbers render large in Mono so the table
// of figures lines up across rows; labels are kept tight at 11px so the
// hero copy retains its dominance. Caller passes pre-formatted strings.
export function HeroStats({
  underManagementUsdc,
  blendedApyPct,
  actionsAuditedCount,
}: HeroStatsProps) {
  return (
    <dl className="grid max-w-md grid-cols-3 gap-4 border-t pt-5 sm:gap-6">
      <div>
        <Mono className="block text-foreground text-xl">${underManagementUsdc}</Mono>
        <dt className="mt-1 text-[11px] text-muted-foreground">Under management</dt>
      </div>
      <div>
        <Mono className="block text-foreground text-xl">{blendedApyPct ?? '—'}</Mono>
        <dt className="mt-1 text-[11px] text-muted-foreground">Blended APY</dt>
      </div>
      <div>
        <Mono className="block text-foreground text-xl">
          {actionsAuditedCount.toLocaleString('en-US')}
        </Mono>
        <dt className="mt-1 text-[11px] text-muted-foreground">Actions audited</dt>
      </div>
    </dl>
  );
}

export function FeatureRow() {
  return (
    <section className="grid w-full max-w-[920px] grid-cols-1 gap-3 md:grid-cols-3">
      <FeatureCard
        kicker="01"
        title="Chat-first"
        body="Move USDC by asking. Every action is proposed, evaluated, and audited."
        example="Deposit 500 USDC to Kamino"
      />
      <FeatureCard
        kicker="02"
        title="Policy-gated"
        body="Caps, allowlist, and approval thresholds enforced at proposal time."
        example="single_tx ≤ $1,000 · daily ≤ $10,000"
      />
      <FeatureCard
        kicker="03"
        title="Kamino · Save · Jupiter"
        body="Deposit, withdraw, and rebalance across three live venues."
        example="Kamino 4.21% · Save 5.08% · Jupiter 4.85%"
      />
    </section>
  );
}

function FeatureCard({
  kicker,
  title,
  body,
  example,
}: {
  kicker: string;
  title: string;
  body: string;
  example: string;
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-lg p-5 shadow-[inset_0_0_0_1px_var(--border)]"
      style={{ backgroundColor: 'var(--card)' }}
    >
      <div className="flex items-center justify-between">
        <Mono className="text-[11px] text-muted-foreground">{kicker}</Mono>
        <ArrowUpRightIcon className="size-3.5 text-muted-foreground" aria-hidden />
      </div>
      <h3 className="font-medium text-base text-foreground">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
      <div className="mt-1 rounded-md px-2.5 py-1.5" style={{ backgroundColor: 'var(--muted)' }}>
        <Mono className="text-[11px] text-muted-foreground">{example}</Mono>
      </div>
    </div>
  );
}
