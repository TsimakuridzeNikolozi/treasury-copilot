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

const M1_VENUES: readonly Venue[] = ['kamino', 'save'];
const DEFERRED_VENUES: readonly Venue[] = ['drift', 'marginfi'];

interface PolicyFormMeta {
  updatedAtIso: string | null;
  updatedBy: string | null;
}

export function PolicyForm({ initial, meta }: { initial: Policy; meta: PolicyFormMeta }) {
  const { getAccessToken } = usePrivy();
  const [requireApprovalAboveUsdc, setRequireApprovalAbove] = useState(
    initial.requireApprovalAboveUsdc,
  );
  const [maxSingleActionUsdc, setMaxSingle] = useState(initial.maxSingleActionUsdc);
  const [maxAutoApprovedUsdcPer24h, setMaxAuto] = useState(initial.maxAutoApprovedUsdcPer24h);
  const [allowedVenues, setAllowedVenues] = useState<Venue[]>([...initial.allowedVenues]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Dirty detection — Save disables when nothing has changed. Compare
  // primitives directly; sort venue arrays so order changes don't count.
  const dirty = useMemo(() => {
    const initialVenues = [...initial.allowedVenues].sort().join(',');
    const currentVenues = [...allowedVenues].sort().join(',');
    return (
      requireApprovalAboveUsdc !== initial.requireApprovalAboveUsdc ||
      maxSingleActionUsdc !== initial.maxSingleActionUsdc ||
      maxAutoApprovedUsdcPer24h !== initial.maxAutoApprovedUsdcPer24h ||
      currentVenues !== initialVenues
    );
  }, [
    requireApprovalAboveUsdc,
    maxSingleActionUsdc,
    maxAutoApprovedUsdcPer24h,
    allowedVenues,
    initial,
  ]);

  // Fade the "Saved" pulse after a few seconds so it doesn't pin forever.
  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 4000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const toggle = (v: Venue) => {
    setAllowedVenues((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
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
          requireApprovalAboveUsdc,
          maxSingleActionUsdc,
          maxAutoApprovedUsdcPer24h,
          allowedVenues,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `${res.status} ${res.statusText}`);
      }
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const allowedCount = allowedVenues.filter((v) => M1_VENUES.includes(v)).length;
  const lastUpdated = formatLastUpdated(meta);

  return (
    <TooltipProvider>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) onSave();
        }}
      >
        <Section
          title="Approval thresholds"
          description="USDC limits applied to every proposed action before it executes."
        >
          <UsdcField
            label="Require approval above"
            hint="Actions at or below this amount auto-approve. Above goes to Telegram for human review."
            value={requireApprovalAboveUsdc}
            onChange={setRequireApprovalAbove}
          />
          <UsdcField
            label="Max single action"
            hint="Hard cap. Actions above this amount are denied outright by the policy engine."
            value={maxSingleActionUsdc}
            onChange={setMaxSingle}
          />
          <UsdcField
            label="Max auto-approved per 24h"
            hint="Cumulative cap on auto-approved actions in any rolling 24-hour window."
            value={maxAutoApprovedUsdcPer24h}
            onChange={setMaxAuto}
          />
        </Section>

        <Section
          title="Allowed venues"
          description="Only venues on this list can be proposed. Drift & Marginfi land in M2."
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              {M1_VENUES.map((v) => {
                const active = allowedVenues.includes(v);
                return (
                  <button
                    type="button"
                    key={v}
                    onClick={() => toggle(v)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      active
                        ? 'border-foreground bg-foreground text-background hover:bg-foreground/90'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 rounded-full',
                        active ? 'bg-background' : 'bg-muted-foreground/40',
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
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-dashed border-border bg-background px-3.5 text-muted-foreground/70 text-sm"
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
            <Button type="submit" disabled={!dirty || saving} className="gap-1.5">
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
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
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
      <InputGroup>
        <InputGroupInput
          id={id}
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText className="font-mono text-muted-foreground text-xs">USDC</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
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
