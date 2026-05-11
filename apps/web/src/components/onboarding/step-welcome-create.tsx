'use client';

import type { WizardTreasury } from '@/app/onboarding/onboarding-client';
import { Button } from '@/components/ui/button';
import type { BootstrapResponse } from '@/lib/api-types';
import { usePrivy } from '@privy-io/react-auth';
import {
  ArrowRightIcon,
  CoinsIcon,
  Loader2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';
import { useState } from 'react';

// Step 1 — Welcome + Create.
//
// Merged step (formerly two separate screens). Renders the explainer +
// "Get started" CTA; the click POSTs /api/me/bootstrap. In local mode
// the bootstrap returns in <100ms — without merging, step 2 would have
// flashed invisibly. In turnkey mode the user sees the spinner copy
// while Turnkey provisions the sub-org (a few seconds).
//
// On success, the parent advances to step 2 with the returned treasury
// embedded in WizardTreasury shape. On failure, an inline Retry surfaces
// the error (502 → raw Turnkey message; otherwise generic copy).

type State =
  | { kind: 'idle' }
  | { kind: 'in_flight'; created: boolean }
  | { kind: 'error'; status: number; message: string };

export function StepWelcomeCreate({
  onAdvance,
}: {
  onAdvance: (treasury: WizardTreasury) => void;
}) {
  const { getAccessToken } = usePrivy();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const start = async () => {
    setState({ kind: 'in_flight', created: false });
    // 200ms delay before flipping to "creating wallet" copy so a
    // sub-100ms local-mode bootstrap doesn't flash the descriptive
    // copy. Mirrors the old / page.tsx pattern.
    const copyTimer = setTimeout(() => {
      setState((cur) => (cur.kind === 'in_flight' ? { ...cur, created: true } : cur));
    }, 200);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/me/bootstrap', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      clearTimeout(copyTimer);
      if (!res.ok) {
        const text = await res.text();
        setState({
          kind: 'error',
          status: res.status,
          message: text || `${res.status} ${res.statusText}`,
        });
        return;
      }
      const body = (await res.json()) as BootstrapResponse;
      onAdvance(body.activeTreasury);
    } catch (err) {
      clearTimeout(copyTimer);
      setState({
        kind: 'error',
        status: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (state.kind === 'in_flight') {
    return (
      <Card>
        <div className="flex flex-col items-center gap-4 py-8 text-center" aria-live="polite">
          <Loader2Icon className="size-8 animate-spin text-muted-foreground" aria-hidden />
          <p className="font-medium text-sm">Setting up your treasury…</p>
          {state.created && (
            <p className="max-w-xs text-muted-foreground text-xs">
              Creating a hardware-secured wallet for you. This takes a few seconds.
            </p>
          )}
        </div>
      </Card>
    );
  }

  if (state.kind === 'error') {
    // 502 is Turnkey-unavailable — surface the raw message so an
    // operator chasing a staging outage gets the signal. Anything else:
    // generic copy.
    const detail =
      state.status === 502
        ? state.message
        : 'We hit a snag setting up your treasury. Please try again.';
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-destructive text-sm">{detail}</p>
          <Button size="sm" onClick={() => setState({ kind: 'idle' })}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl border bg-muted"
        >
          <CoinsIcon className="size-6 text-primary" />
        </div>
        <h1 className="font-semibold text-3xl tracking-tight">Welcome to Treasury Copilot</h1>
        <p className="max-w-md text-balance text-muted-foreground text-sm">
          Move USDC across Solana yield venues by chatting. Every action runs through a policy
          engine — caps, allowlist, and human approval where it matters.
        </p>
      </div>
      <ul className="flex flex-col gap-3 sm:gap-2">
        <Bullet
          icon={<SparklesIcon className="size-4" aria-hidden />}
          title="Chat-first"
          body="Ask in plain English. The agent proposes; the policy engine decides."
        />
        <Bullet
          icon={<ShieldCheckIcon className="size-4" aria-hidden />}
          title="Policy-gated"
          body="Auto-approve small moves; require Telegram approval above your cap."
        />
        <Bullet
          icon={<CoinsIcon className="size-4" aria-hidden />}
          title="Hardware-secured"
          body="Your wallet lives in Turnkey HSM. Only you can authorize moves."
        />
      </ul>
      <div className="flex justify-center">
        <Button size="lg" onClick={start} className="gap-2">
          Get started
          <ArrowRightIcon className="size-4" aria-hidden />
        </Button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-6 rounded-xl border bg-card p-6 sm:gap-8 sm:p-8">
      {children}
    </section>
  );
}

function Bullet({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground"
      >
        {icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-sm">{title}</span>
        <span className="text-muted-foreground text-xs leading-relaxed">{body}</span>
      </div>
    </li>
  );
}
