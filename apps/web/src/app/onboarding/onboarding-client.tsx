'use client';

import { ProgressIndicator } from '@/components/onboarding/progress-indicator';
import { StepFundWallet } from '@/components/onboarding/step-fund-wallet';
import { StepGuardrails } from '@/components/onboarding/step-guardrails';
import { StepReady } from '@/components/onboarding/step-ready';
import { StepTelegram } from '@/components/onboarding/step-telegram';
import { StepWelcomeCreate } from '@/components/onboarding/step-welcome-create';
import { usePrivy } from '@privy-io/react-auth';
import { useState } from 'react';

// Minimal projection of TreasuryRow that the wizard's steps actually
// consume. Defined here (not exported from @tc/db) so the client bundle
// doesn't pull the full Drizzle row type and its transitive jsonb /
// numeric column guts.
export interface WizardTreasury {
  id: string;
  name: string;
  walletAddress: string;
}

type Step = 1 | 2 | 3 | 4 | 5;
const TOTAL_STEPS = 5;

interface Props {
  initialStep: Step;
  initialTreasury: WizardTreasury | null;
}

// M2 PR 5 / wizard state machine.
//
// Single URL `/onboarding` hosting an in-memory step pointer + treasury
// reference. Each "Continue" / "Skip" CTA POSTs `/api/me/onboarding-step`
// before advancing locally so refresh / cross-tab resume lands in the
// right place. The POST is best-effort — if it fails the client still
// advances; refresh would re-derive the saved step (one CTA behind, but
// never corrupt). Step 5's "Open chat" CTA POSTs `/api/me/onboarded`
// (sets onboarded_at) and `await`s the result — we *do* block here
// because a failed call leaves the user bounceable back into the
// wizard, which is more confusing than an inline retry.
export function OnboardingClient({ initialStep, initialTreasury }: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  const [treasury, setTreasury] = useState<WizardTreasury | null>(initialTreasury);
  const { getAccessToken } = usePrivy();

  // Defense-in-depth: if the server thinks we're at step >1 but no
  // treasury exists (data drift, manual DB edit), fall back to step 1
  // so the user re-runs bootstrap. Idempotent — bootstrap returns
  // created:false on existing memberships, so re-running step 1 is
  // safe even after partial wizard progression.
  const effectiveStep: Step = step > 1 && !treasury ? 1 : step;

  // Best-effort persistence. Errors swallowed (we'd rather let the user
  // keep going than block them on a network blip; a stale onboarding_step
  // just means refresh resumes one step behind).
  const persistStep = async (next: Step) => {
    try {
      const token = await getAccessToken();
      await fetch('/api/me/onboarding-step', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ step: next }),
      });
    } catch {
      // Non-fatal — ignore.
    }
  };

  const advance = async (next: Step) => {
    await persistStep(next);
    setStep(next);
  };

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="px-6 pt-12 pb-6 sm:pt-16">
        <ProgressIndicator current={effectiveStep} total={TOTAL_STEPS} />
      </header>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 pb-16">
        {effectiveStep === 1 && (
          <StepWelcomeCreate
            onAdvance={(t) => {
              setTreasury(t);
              void advance(2);
            }}
          />
        )}
        {effectiveStep === 2 && treasury && (
          <StepFundWallet treasury={treasury} onAdvance={() => void advance(3)} />
        )}
        {effectiveStep === 3 && treasury && (
          <StepGuardrails treasury={treasury} onAdvance={() => void advance(4)} />
        )}
        {effectiveStep === 4 && treasury && (
          <StepTelegram treasury={treasury} onAdvance={() => void advance(5)} />
        )}
        {effectiveStep === 5 && <StepReady />}
      </div>
    </main>
  );
}
