'use client';

import type { WizardTreasury } from '@/app/onboarding/onboarding-client';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { DEFAULT_POLICY } from '@tc/policy';
import type { Policy } from '@tc/policy';
import { Loader2Icon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

// Step 3 — Set guardrails.
//
// Compact 2-field policy editor (auto-approve threshold + daily cap).
// We deliberately avoid retrofitting an `embed` mode onto PolicyForm —
// the wizard's step needs its own button row ("Use defaults" + "Continue")
// and the dirty/baseline machinery in PolicyForm is overkill for a
// one-shot first-time form.
//
// Both CTAs **always write a policies row** (PR 5 review fix #3):
//   - "Use defaults" submits DEFAULT_POLICY literally — explicit consent.
//   - "Continue" submits the user's edits.
//
// The other two policy fields the API requires are derived:
//   - maxSingleActionUsdc = state.maxAutoApprovedUsdcPer24h
//     (single-action cap mirrors daily cap; cross-field invariant
//     `requireApprovalAboveUsdc <= maxSingleActionUsdc` holds because
//     the user's threshold is always ≤ daily cap.)
//   - allowedVenues = ['kamino', 'save'] (M2 venue coverage; matches
//     DEFAULT_POLICY).

const USDC_FORMAT = /^\d+(\.\d+)?$/;
const SUBMIT_TIMEOUT_MS = 15_000;

interface CompactState {
  requireApprovalAboveUsdc: string;
  maxAutoApprovedUsdcPer24h: string;
}

function policyToState(p: Policy): CompactState {
  return {
    requireApprovalAboveUsdc: p.requireApprovalAboveUsdc,
    maxAutoApprovedUsdcPer24h: p.maxAutoApprovedUsdcPer24h,
  };
}

export function StepGuardrails({
  treasury,
  onAdvance,
}: {
  treasury: WizardTreasury;
  onAdvance: () => void;
}) {
  const { getAccessToken } = usePrivy();
  const [state, setState] = useState<CompactState>(() => policyToState(DEFAULT_POLICY));
  const [saving, setSaving] = useState<'idle' | 'defaults' | 'custom'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Both fields must match the API's accepted format before the
  // cross-field comparison runs — empty strings and exponent notation
  // (e.g. "1e5") are accepted by Number.parseFloat but rejected by the
  // API's regex, so we pre-screen them here to keep Continue disabled
  // until inputs are well-formed.
  const formatValid = useMemo(
    () =>
      USDC_FORMAT.test(state.requireApprovalAboveUsdc) &&
      USDC_FORMAT.test(state.maxAutoApprovedUsdcPer24h),
    [state.requireApprovalAboveUsdc, state.maxAutoApprovedUsdcPer24h],
  );

  const requireGtCap = useMemo(() => {
    if (!formatValid) return false;
    const a = Number.parseFloat(state.requireApprovalAboveUsdc);
    const b = Number.parseFloat(state.maxAutoApprovedUsdcPer24h);
    return a > b;
  }, [state.requireApprovalAboveUsdc, state.maxAutoApprovedUsdcPer24h, formatValid]);

  const submit = async (values: CompactState, mode: 'defaults' | 'custom') => {
    setSaving(mode);
    setError(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/policy', {
        method: 'PATCH',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          requireApprovalAboveUsdc: values.requireApprovalAboveUsdc,
          maxSingleActionUsdc: values.maxAutoApprovedUsdcPer24h,
          maxAutoApprovedUsdcPer24h: values.maxAutoApprovedUsdcPer24h,
          allowedVenues: DEFAULT_POLICY.allowedVenues,
          treasuryId: treasury.id,
        }),
      });
      clearTimeout(timeoutId);
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'no_active_treasury') {
          window.location.replace('/');
          return;
        }
        window.location.reload();
        return;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${res.status} ${res.statusText}`);
      }
      onAdvance();
    } catch (e) {
      clearTimeout(timeoutId);
      if (e instanceof DOMException && e.name === 'AbortError') {
        setError('Request timed out. Please try again.');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving('idle');
    }
  };

  const onUseDefaults = () => submit(policyToState(DEFAULT_POLICY), 'defaults');
  const onContinue = () => {
    if (requireGtCap) return;
    submit(state, 'custom');
  };

  return (
    <section className="flex flex-col gap-6 rounded-xl border bg-card p-6 sm:gap-8 sm:p-8">
      <header className="flex flex-col gap-2 text-center">
        <h2 className="font-semibold text-2xl tracking-tight">Set your guardrails</h2>
        <p className="mx-auto max-w-md text-balance text-muted-foreground text-sm">
          Larger moves need Telegram approval. You can change these any time in Settings.
        </p>
      </header>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          onContinue();
        }}
      >
        <UsdcField
          label="Auto-approve up to"
          name="require-approval-above-usdc"
          hint="Actions at or below this amount auto-approve. Above goes to Telegram for human review."
          value={state.requireApprovalAboveUsdc}
          onChange={(v) => setState((cur) => ({ ...cur, requireApprovalAboveUsdc: v }))}
          error={requireGtCap ? 'Must be at most the daily cap.' : undefined}
        />
        <UsdcField
          label="Daily cap"
          name="max-auto-approved-usdc-per-24h"
          hint="Cumulative cap on auto-approved actions in any rolling 24-hour window."
          value={state.maxAutoApprovedUsdcPer24h}
          onChange={(v) => setState((cur) => ({ ...cur, maxAutoApprovedUsdcPer24h: v }))}
        />
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
          Allowed venues: <span className="font-mono">kamino</span>,{' '}
          <span className="font-mono">save</span>. Edit later in Settings.
        </p>
        <div className="flex items-center justify-end gap-3">
          {error && (
            <span className="max-w-[20rem] truncate text-destructive text-xs" title={error}>
              {error}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={onUseDefaults}
            disabled={saving !== 'idle'}
            className="gap-1.5"
          >
            {saving === 'defaults' && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
            Use defaults
          </Button>
          <Button type="submit" disabled={saving !== 'idle' || !formatValid || requireGtCap} className="gap-1.5">
            {saving === 'custom' && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
            Continue
          </Button>
        </div>
      </form>
    </section>
  );
}

function UsdcField({
  label,
  name,
  hint,
  value,
  onChange,
  error,
}: {
  label: string;
  name: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      <InputGroup
        className={cn(error && 'border-destructive focus-within:ring-destructive')}
      >
        <InputGroupInput
          id={id}
          name={name}
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          aria-invalid={Boolean(error) || undefined}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="font-mono text-muted-foreground text-xs">USDC</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        {hint}
      </p>
      {error && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
