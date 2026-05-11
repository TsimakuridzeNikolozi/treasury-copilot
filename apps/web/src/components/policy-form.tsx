'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import type { Policy } from '@tc/policy';
import type { Venue } from '@tc/types';
import { CheckCircle2Icon, InfoIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

const ENABLED_VENUES: readonly Venue[] = ['kamino', 'save', 'jupiter'];
const DEFERRED_VENUES: readonly Venue[] = ['drift', 'marginfi'];

interface PolicyFormMeta {
  updatedAtIso: string | null;
  updatedBy: string | null;
}

interface FormState {
  requireApprovalAboveUsdc: string;
  maxSingleActionUsdc: string;
  maxAutoApprovedUsdcPer24h: string;
  allowedVenues: Venue[];
}

function policyToState(p: Policy): FormState {
  return {
    requireApprovalAboveUsdc: p.requireApprovalAboveUsdc,
    maxSingleActionUsdc: p.maxSingleActionUsdc,
    maxAutoApprovedUsdcPer24h: p.maxAutoApprovedUsdcPer24h,
    allowedVenues: [...p.allowedVenues],
  };
}

function venuesEqual(a: readonly Venue[], b: readonly Venue[]): boolean {
  return [...a].sort().join(',') === [...b].sort().join(',');
}

export function PolicyForm({
  initial,
  meta,
  treasuryId,
}: { initial: Policy; meta: PolicyFormMeta; treasuryId: string }) {
  const { getAccessToken } = usePrivy();

  // The form has TWO sources of truth that look similar but mean different
  // things:
  //   - `initial`     — the prop passed from the server page (frozen at SSR).
  //   - `baseline`    — the values we last successfully persisted. Drives
  //                     dirty detection; updated after a 204 from PATCH.
  // Without `baseline`, a successful save leaves `initial` untouched and the
  // dirty flag stays true forever — operators end up double-clicking Save.
  // The DB also normalises numerics (`'500'` → `'500.000000'`) so even the
  // exact same submitted values would compare unequal to `initial`.
  const [state, setState] = useState<FormState>(() => policyToState(initial));
  const [baseline, setBaseline] = useState<FormState>(() => policyToState(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Today the only path that swaps treasury reloads the page, so this
  // effect is dormant on the live UX. Kept as defense-in-depth: if a
  // future change re-renders PolicyForm in place with a new treasuryId
  // (e.g. an SPA-style switcher), stale form values would otherwise be
  // submitted against the new treasury.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the identity-changing inputs should trigger a reset; ignoring object-shape churn on `initial`.
  useEffect(() => {
    const fresh = policyToState(initial);
    setState(fresh);
    setBaseline(fresh);
    setError(null);
    setSavedAt(null);
  }, [treasuryId, initial]);

  const dirty = useMemo(
    () =>
      state.requireApprovalAboveUsdc !== baseline.requireApprovalAboveUsdc ||
      state.maxSingleActionUsdc !== baseline.maxSingleActionUsdc ||
      state.maxAutoApprovedUsdcPer24h !== baseline.maxAutoApprovedUsdcPer24h ||
      !venuesEqual(state.allowedVenues, baseline.allowedVenues),
    [state, baseline],
  );

  // Cross-field invariant — an action above `maxSingleActionUsdc` is denied,
  // so `requireApprovalAboveUsdc` cannot sit above it (that config would
  // auto-deny every action). API enforces the same; mirror here so users
  // see the issue without a round-trip. parseFloat is safe for the cap
  // magnitudes we accept; the regex on the API side rejects scientific.
  const requireGtMax = useMemo(() => {
    const a = Number.parseFloat(state.requireApprovalAboveUsdc);
    const b = Number.parseFloat(state.maxSingleActionUsdc);
    return Number.isFinite(a) && Number.isFinite(b) && a > b;
  }, [state.requireApprovalAboveUsdc, state.maxSingleActionUsdc]);

  const allowedCount = state.allowedVenues.filter((v) => ENABLED_VENUES.includes(v)).length;
  const blocking = requireGtMax || allowedCount === 0;

  // Fade the "Saved" pulse after a few seconds so it doesn't pin forever.
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 4000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((cur) => ({ ...cur, [key]: value }));
  };

  const toggle = (v: Venue) => {
    setState((cur) => ({
      ...cur,
      allowedVenues: cur.allowedVenues.includes(v)
        ? cur.allowedVenues.filter((x) => x !== v)
        : [...cur.allowedVenues, v],
    }));
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/policy', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          requireApprovalAboveUsdc: state.requireApprovalAboveUsdc,
          maxSingleActionUsdc: state.maxSingleActionUsdc,
          maxAutoApprovedUsdcPer24h: state.maxAutoApprovedUsdcPer24h,
          allowedVenues: state.allowedVenues,
          treasuryId,
        }),
      });
      // 409 means the active treasury moved underneath us (multi-tab) or
      // is gone (mid-bootstrap). Force a full reload so the form
      // re-renders against the new treasury's policy. No partial save.
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
        const body = await res.text();
        throw new Error(body || `${res.status} ${res.statusText}`);
      }
      // Snap baseline forward so dirty drops back to false. We deliberately
      // don't refetch — server-normalised numerics (e.g. '500' →
      // '500.000000') would re-render the user's input mid-edit and feel
      // jumpy. Their typed string is the truth-of-record until the next
      // page load.
      setBaseline(state);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const lastUpdated = formatLastUpdated(meta);

  return (
    <TooltipProvider>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !blocking) onSave();
        }}
      >
        <Section
          title="Approval thresholds"
          description="USDC limits applied to every proposed action before it executes."
        >
          <UsdcField
            label="Require approval above"
            hint="Actions at or below this amount auto-approve. Above goes to Telegram for human review."
            value={state.requireApprovalAboveUsdc}
            onChange={(v) => setField('requireApprovalAboveUsdc', v)}
            error={requireGtMax ? 'Must be at most the max-single-action cap.' : undefined}
          />
          <UsdcField
            label="Max single action"
            hint="Hard cap. Actions above this amount are denied outright by the policy engine."
            value={state.maxSingleActionUsdc}
            onChange={(v) => setField('maxSingleActionUsdc', v)}
          />
          <UsdcField
            label="Max auto-approved per 24h"
            hint="Cumulative cap on auto-approved actions in any rolling 24-hour window."
            value={state.maxAutoApprovedUsdcPer24h}
            onChange={(v) => setField('maxAutoApprovedUsdcPer24h', v)}
          />
        </Section>

        <Section
          title="Allowed venues"
          description="Only venues on this list can be proposed. Drift & Marginfi are deferred."
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {ENABLED_VENUES.map((v) => {
                const active = state.allowedVenues.includes(v);
                return (
                  <button
                    type="button"
                    key={v}
                    onClick={() => toggle(v)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      active
                        ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 rounded-full',
                        active ? 'bg-primary-foreground' : 'bg-muted-foreground/40',
                      )}
                    />
                    {v}
                  </button>
                );
              })}
              {DEFERRED_VENUES.map((v) => (
                <span
                  key={v}
                  aria-disabled
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-border border-dashed bg-background px-3.5 text-muted-foreground/70 text-sm"
                >
                  {v}
                  <Badge variant="outline" className="border-border/60 text-[10px] uppercase">
                    M2
                  </Badge>
                </span>
              ))}
            </div>
            {allowedCount === 0 && (
              <p className="text-amber-600 text-xs dark:text-amber-400">
                No venues selected — every proposal will be denied until you re-enable at least one.
              </p>
            )}
          </div>
        </Section>

        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border bg-card/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <p className="text-muted-foreground text-xs">
            {dirty ? (
              <span className="text-foreground">Unsaved changes</span>
            ) : (
              <>Last updated {lastUpdated}</>
            )}
          </p>
          <div className="flex items-center gap-3">
            {savedAt && !error && (
              <span className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
                <CheckCircle2Icon className="size-3.5" aria-hidden /> Saved
              </span>
            )}
            {error && (
              <span className="max-w-[20rem] truncate text-destructive text-xs" title={error}>
                {error}
              </span>
            )}
            <Button type="submit" disabled={!dirty || saving || blocking} className="gap-1.5">
              {saving && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
              {saving ? 'Saving' : 'Save changes'}
            </Button>
          </div>
        </div>
      </form>
    </TooltipProvider>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="border-b px-5 py-3.5">
        <h2 className="font-medium text-sm">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>
      </header>
      <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
    </section>
  );
}

function UsdcField({
  label,
  hint,
  value,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="font-medium text-sm">
          {label}
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`What does "${label}" mean?`}
              className="-m-1 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <InfoIcon className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {hint}
          </TooltipContent>
        </Tooltip>
      </div>
      <InputGroup
        className={cn(error && 'border-destructive focus-within:ring-destructive')}
        aria-invalid={Boolean(error) || undefined}
      >
        <InputGroupInput
          id={id}
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="font-mono text-muted-foreground text-xs">USDC</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
      {error && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

function formatLastUpdated(meta: PolicyFormMeta): string {
  if (!meta.updatedAtIso) return 'never (using defaults)';
  const date = new Date(meta.updatedAtIso);
  const when = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (!meta.updatedBy) return when;
  // Show the trailing 6 chars of the DID — full DIDs are noisy; emails are
  // shown verbatim if they happen to be in the actor field.
  const actor = meta.updatedBy.includes('@') ? meta.updatedBy : `…${meta.updatedBy.slice(-6)}`;
  return `${when} by ${actor}`;
}
