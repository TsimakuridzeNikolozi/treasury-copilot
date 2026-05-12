'use client';

import { StepFundWallet } from '@/components/onboarding/step-fund-wallet';
import { StepGuardrails } from '@/components/onboarding/step-guardrails';
import { StepIndicator } from '@/components/onboarding/step-indicator';
import { StepReady } from '@/components/onboarding/step-ready';
import { StepTelegram } from '@/components/onboarding/step-telegram';
import { StepWelcomeCreate } from '@/components/onboarding/step-welcome-create';
import { OnboardingShell } from '@/components/shells/onboarding-shell';
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

interface Props {
  initialStep: Step;
  initialTreasury: WizardTreasury | null;
}

export function OnboardingClient({ initialStep, initialTreasury }: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  const [treasury, setTreasury] = useState<WizardTreasury | null>(initialTreasury);
  const { getAccessToken } = usePrivy();

  // Defense-in-depth: if the server thinks we're at step >1 but no
  // treasury exists (data drift, manual DB edit), fall back to step 1
  // so the user re-runs bootstrap. Idempotent — bootstrap returns
  // created:false on existing memberships, so re-running step 1 is safe.
  const effectiveStep: Step = step > 1 && !treasury ? 1 : step;

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
      // Non-fatal — refresh resumes one step behind.
    }
  };

  const advance = async (next: Step) => {
    await persistStep(next);
    setStep(next);
  };

  const jumpBack = (target: number) => {
    if (target >= 1 && target < effectiveStep) {
      const next = target as Step;
      void persistStep(next);
      setStep(next);
    }
  };

  return (
    <OnboardingShell>
      <div className="w-full max-w-[560px]">
        <StepIndicator current={effectiveStep} onJump={jumpBack} />

        <div className="mt-10">
          {effectiveStep === 1 ? (
            <StepWelcomeCreate
              onAdvance={(t) => {
                setTreasury(t);
                void advance(2);
              }}
            />
          ) : null}
          {effectiveStep === 2 && treasury ? (
            <StepFundWallet treasury={treasury} onAdvance={() => void advance(3)} />
          ) : null}
          {effectiveStep === 3 && treasury ? (
            <StepGuardrails treasury={treasury} onAdvance={() => void advance(4)} />
          ) : null}
          {effectiveStep === 4 && treasury ? (
            <StepTelegram treasury={treasury} onAdvance={() => void advance(5)} />
          ) : null}
          {effectiveStep === 5 ? <StepReady /> : null}
        </div>
      </div>
    </OnboardingShell>
  );
}
