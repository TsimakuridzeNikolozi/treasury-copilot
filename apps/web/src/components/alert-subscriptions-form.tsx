'use client';

import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

// Mirrors @tc/db's AlertKind. Inlined to avoid pulling a db import into a
// client component (and the deps it would drag through the bundler).
type AlertKind = 'yield_drift' | 'idle_capital' | 'anomaly' | 'concentration' | 'protocol_health';

interface YieldDriftConfig {
  minDriftBps: number;
  minOpportunityUsdcPerMonth: number;
  sustainHours: number;
  cooldownHours: number;
}

interface IdleCapitalConfig {
  minIdleUsdc: number;
  minDwellHours: number;
  cooldownHours: number;
}

// Mirrors the `SubscriptionDto` shape returned by GET /api/alerts in
// apps/web/src/app/api/alerts/route.ts. Defined separately because this
// is a client component and the route's type imports @tc/db — the two
// must stay structurally identical; changes here need a mirror edit in
// the route's `SubscriptionDto`.
export interface AlertSubscriptionDto {
  kind: AlertKind;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt: string | null;
  updatedBy: string | null;
}

// Each entry's `wired` flag controls whether the threshold editor is
// shown. M3-2 wires yield_drift, M3-3 wires idle_capital; the other
// three ride the toggle surface and will get their editors when their
// respective worker jobs land. Keeping them visible (with "coming soon"
// copy) lets users see the full surface area + opt in early for kinds
// they want when ready.
const KINDS: ReadonlyArray<{
  kind: AlertKind;
  label: string;
  hint: string;
  wired: boolean;
}> = [
  {
    kind: 'yield_drift',
    label: 'Yield drift',
    hint: 'Tells you when a held venue trails another by more than the threshold for the sustain window.',
    wired: true,
  },
  {
    kind: 'idle_capital',
    label: 'Idle capital',
    hint: "Nudges you when wallet USDC has sat undeployed past the dwell threshold, with the best venue's APY and projected monthly upside.",
    wired: true,
  },
  {
    kind: 'anomaly',
    label: 'Anomaly',
    hint: 'Surfaces unusual yield underperformance or outflow spikes. Available in M3-5.',
    wired: false,
  },
  {
    kind: 'concentration',
    label: 'Concentration',
    hint: 'Warns when one venue holds more than the threshold share of total liquid. Available in M5-1.',
    wired: false,
  },
  {
    kind: 'protocol_health',
    label: 'Protocol health',
    hint: 'Pings on TVL drops, paused withdrawals, or utilization spikes for venues you hold. Available in M5-2.',
    wired: false,
  },
];

// Plan defaults — same as the migration's seed and the policy/yield-drift
// query's `YIELD_DRIFT_DEFAULT_CONFIG`. Inlined for the same reason as
// AlertKind: keeps the client off the db package.
const YIELD_DRIFT_DEFAULTS: YieldDriftConfig = {
  minDriftBps: 100,
  minOpportunityUsdcPerMonth: 25,
  sustainHours: 24,
  cooldownHours: 24,
};

// Mirrors @tc/db's IDLE_CAPITAL_DEFAULT_CONFIG. Same client-component
// inlining rationale.
const IDLE_CAPITAL_DEFAULTS: IdleCapitalConfig = {
  minIdleUsdc: 5000,
  minDwellHours: 72,
  cooldownHours: 48,
};

// Indexed shape so dirty detection is a single object comparison. Keys are
// the AlertKind values; each value carries the enabled flag and the
// per-kind config (only yield_drift has meaningful editable config in this
// PR — the rest carry `{}`).
type FormState = Record<AlertKind, { enabled: boolean; config: Record<string, unknown> }>;

function defaultConfigFor(kind: AlertKind): Record<string, unknown> {
  if (kind === 'yield_drift') return { ...YIELD_DRIFT_DEFAULTS };
  if (kind === 'idle_capital') return { ...IDLE_CAPITAL_DEFAULTS };
  return {};
}

function fromInitial(rows: AlertSubscriptionDto[]): FormState {
  const out = {} as FormState;
  for (const { kind } of KINDS) {
    const row = rows.find((r) => r.kind === kind);
    out[kind] = {
      enabled: row?.enabled ?? false,
      config: row?.config ?? defaultConfigFor(kind),
    };
  }
  return out;
}

function readIdleCapital(state: FormState): IdleCapitalConfig {
  const cfg = state.idle_capital.config as Partial<IdleCapitalConfig>;
  return {
    minIdleUsdc:
      typeof cfg.minIdleUsdc === 'number' ? cfg.minIdleUsdc : IDLE_CAPITAL_DEFAULTS.minIdleUsdc,
    minDwellHours:
      typeof cfg.minDwellHours === 'number'
        ? cfg.minDwellHours
        : IDLE_CAPITAL_DEFAULTS.minDwellHours,
    cooldownHours:
      typeof cfg.cooldownHours === 'number'
        ? cfg.cooldownHours
        : IDLE_CAPITAL_DEFAULTS.cooldownHours,
  };
}

function readYieldDrift(state: FormState): YieldDriftConfig {
  const cfg = state.yield_drift.config as Partial<YieldDriftConfig>;
  return {
    minDriftBps:
      typeof cfg.minDriftBps === 'number' ? cfg.minDriftBps : YIELD_DRIFT_DEFAULTS.minDriftBps,
    minOpportunityUsdcPerMonth:
      typeof cfg.minOpportunityUsdcPerMonth === 'number'
        ? cfg.minOpportunityUsdcPerMonth
        : YIELD_DRIFT_DEFAULTS.minOpportunityUsdcPerMonth,
    sustainHours:
      typeof cfg.sustainHours === 'number' ? cfg.sustainHours : YIELD_DRIFT_DEFAULTS.sustainHours,
    cooldownHours:
      typeof cfg.cooldownHours === 'number'
        ? cfg.cooldownHours
        : YIELD_DRIFT_DEFAULTS.cooldownHours,
  };
}

// Mirror of api/alerts/route.ts's idle-capital validation.
function validateIdleCapital(cfg: IdleCapitalConfig): string | null {
  if (cfg.minIdleUsdc < 1 || cfg.minIdleUsdc > 1_000_000_000) {
    return 'Min idle USDC must be between $1 and $1B.';
  }
  if (!Number.isInteger(cfg.minDwellHours) || cfg.minDwellHours < 1 || cfg.minDwellHours > 720) {
    return 'Min dwell hours must be a whole number between 1 and 720.';
  }
  if (!Number.isInteger(cfg.cooldownHours) || cfg.cooldownHours < 1 || cfg.cooldownHours > 720) {
    return 'Cooldown hours must be a whole number between 1 and 720.';
  }
  return null;
}

// Mirror of api/alerts/route.ts's yield-drift validation. Keeps the user's
// inline feedback consistent with the eventual server reject reason.
function validateYieldDrift(cfg: YieldDriftConfig): string | null {
  if (!Number.isInteger(cfg.minDriftBps) || cfg.minDriftBps < 1 || cfg.minDriftBps > 10_000) {
    return 'Min drift must be a whole number between 1 and 10000 bps.';
  }
  if (cfg.minOpportunityUsdcPerMonth < 0 || cfg.minOpportunityUsdcPerMonth > 1_000_000_000) {
    return 'Min opportunity must be between $0 and $1B/mo.';
  }
  if (!Number.isInteger(cfg.sustainHours) || cfg.sustainHours < 1 || cfg.sustainHours > 168) {
    return 'Sustain hours must be a whole number between 1 and 168.';
  }
  if (!Number.isInteger(cfg.cooldownHours) || cfg.cooldownHours < 1 || cfg.cooldownHours > 168) {
    return 'Cooldown hours must be a whole number between 1 and 168.';
  }
  return null;
}

export function AlertSubscriptionsForm({
  initial,
  treasuryId,
}: {
  initial: AlertSubscriptionDto[];
  treasuryId: string;
}) {
  const { getAccessToken } = usePrivy();

  const [state, setState] = useState<FormState>(() => fromInitial(initial));
  const [baseline, setBaseline] = useState<FormState>(() => fromInitial(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Mirrors PolicyForm: if a future SPA-switcher path re-renders the form
  // with a new treasuryId, reset both state and baseline so stale values
  // don't leak.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only treasuryId / initial identity should re-init.
  useEffect(() => {
    const fresh = fromInitial(initial);
    setState(fresh);
    setBaseline(fresh);
    setError(null);
    setSavedAt(null);
  }, [treasuryId, initial]);

  // List of kinds that differ from baseline. PATCH fires once per dirty
  // kind on save, so the API stays per-row idempotent.
  const dirtyKinds = useMemo<AlertKind[]>(() => {
    return KINDS.flatMap(({ kind }) =>
      state[kind].enabled !== baseline[kind].enabled ||
      JSON.stringify(state[kind].config) !== JSON.stringify(baseline[kind].config)
        ? [kind]
        : [],
    );
  }, [state, baseline]);

  const yieldDriftError = useMemo(() => {
    if (!state.yield_drift.enabled) return null;
    return validateYieldDrift(readYieldDrift(state));
  }, [state]);

  const idleCapitalError = useMemo(() => {
    if (!state.idle_capital.enabled) return null;
    return validateIdleCapital(readIdleCapital(state));
  }, [state]);

  const blocking = yieldDriftError !== null || idleCapitalError !== null;

  useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 4000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      for (const kind of dirtyKinds) {
        let body: Record<string, unknown>;
        if (kind === 'yield_drift') {
          body = {
            treasuryId,
            kind,
            enabled: state.yield_drift.enabled,
            config: readYieldDrift(state),
          };
        } else if (kind === 'idle_capital') {
          body = {
            treasuryId,
            kind,
            enabled: state.idle_capital.enabled,
            config: readIdleCapital(state),
          };
        } else {
          body = {
            treasuryId,
            kind,
            enabled: state[kind].enabled,
            config: state[kind].config,
          };
        }
        const res = await fetch('/api/alerts', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
        if (res.status === 409) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          if (b.error === 'no_active_treasury') {
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
      }
      setBaseline(state);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const yd = readYieldDrift(state);
  const ic = readIdleCapital(state);

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirtyKinds.length > 0 && !blocking) onSave();
      }}
    >
      <div className="flex flex-col gap-4">
        {KINDS.map((entry) => {
          const row = state[entry.kind];
          return (
            <Card key={entry.kind}>
              <CardHeader
                label={entry.label}
                hint={entry.hint}
                wired={entry.wired}
                enabled={row.enabled}
                onToggle={(next) =>
                  setState((cur) => ({
                    ...cur,
                    [entry.kind]: { ...cur[entry.kind], enabled: next },
                  }))
                }
              />
              {entry.kind === 'yield_drift' && row.enabled && (
                <YieldDriftEditor
                  value={yd}
                  onChange={(next) =>
                    setState((cur) => ({
                      ...cur,
                      yield_drift: {
                        ...cur.yield_drift,
                        config: next as unknown as Record<string, unknown>,
                      },
                    }))
                  }
                  error={yieldDriftError}
                />
              )}
              {entry.kind === 'idle_capital' && row.enabled && (
                <IdleCapitalEditor
                  value={ic}
                  onChange={(next) =>
                    setState((cur) => ({
                      ...cur,
                      idle_capital: {
                        ...cur.idle_capital,
                        config: next as unknown as Record<string, unknown>,
                      },
                    }))
                  }
                  error={idleCapitalError}
                />
              )}
            </Card>
          );
        })}
      </div>

      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border bg-card/95 p-3 shadow-sm backdrop-blur supports-backdrop-filter:bg-card/80">
        <p className="text-muted-foreground text-xs">
          {dirtyKinds.length > 0 ? (
            <span className="text-foreground">
              {dirtyKinds.length} unsaved change{dirtyKinds.length === 1 ? '' : 's'}
            </span>
          ) : (
            'Saved'
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
          <Button
            type="submit"
            disabled={dirtyKinds.length === 0 || saving || blocking}
            className="gap-1.5"
          >
            {saving && <Loader2Icon className="size-4 animate-spin" aria-hidden />}
            {saving ? 'Saving' : 'Save changes'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-lg border bg-card">{children}</section>;
}

function CardHeader({
  label,
  hint,
  wired,
  enabled,
  onToggle,
}: {
  label: string;
  hint: string;
  wired: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b px-5 py-3.5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm">{label}</h3>
          {!wired && (
            <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
              Coming soon
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <ToggleSwitch checked={enabled} onChange={onToggle} label={label} />
    </header>
  );
}

// Local toggle pill — mirrors the venue-toggle visual language in policy-form
// without dragging in @radix-ui/react-switch. Pure button with aria-pressed.
function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Toggle ${label}`}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted hover:bg-muted/80',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block size-5 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function YieldDriftEditor({
  value,
  onChange,
  error,
}: {
  value: YieldDriftConfig;
  onChange: (next: YieldDriftConfig) => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumField
          label="Min drift"
          suffix="bps"
          value={value.minDriftBps}
          onChange={(v) => onChange({ ...value, minDriftBps: v })}
          help="Don't fire below this much difference (100bps = 1%)."
          step={1}
          min={1}
          max={10_000}
        />
        <NumField
          label="Min opportunity"
          prefix="$"
          suffix="/mo"
          value={value.minOpportunityUsdcPerMonth}
          onChange={(v) => onChange({ ...value, minOpportunityUsdcPerMonth: v })}
          help="Ignore drift below this projected monthly upside."
          step={1}
          min={0}
          max={1_000_000_000}
        />
        <NumField
          label="Sustain window"
          suffix="hours"
          value={value.sustainHours}
          onChange={(v) => onChange({ ...value, sustainHours: v })}
          help="Compare 24h-style averages over this window."
          step={1}
          min={1}
          max={168}
        />
        <NumField
          label="Cooldown"
          suffix="hours"
          value={value.cooldownHours}
          onChange={(v) => onChange({ ...value, cooldownHours: v })}
          help="Don't re-fire the same drift pair within this window."
          step={1}
          min={1}
          max={168}
        />
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function IdleCapitalEditor({
  value,
  onChange,
  error,
}: {
  value: IdleCapitalConfig;
  onChange: (next: IdleCapitalConfig) => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumField
          label="Min idle USDC"
          prefix="$"
          value={value.minIdleUsdc}
          onChange={(v) => onChange({ ...value, minIdleUsdc: v })}
          help="Skip wallets sitting below this much USDC."
          step={1}
          min={1}
          max={1_000_000_000}
        />
        <NumField
          label="Min dwell"
          suffix="hours"
          value={value.minDwellHours}
          onChange={(v) => onChange({ ...value, minDwellHours: v })}
          help="Wait this long since the last deposit / transfer / rebalance."
          step={1}
          min={1}
          max={720}
        />
        <NumField
          label="Cooldown"
          suffix="hours"
          value={value.cooldownHours}
          onChange={(v) => onChange({ ...value, cooldownHours: v })}
          help="Don't re-fire for this wallet within the window."
          step={1}
          min={1}
          max={720}
        />
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

function NumField({
  label,
  prefix,
  suffix,
  value,
  onChange,
  help,
  step,
  min,
  max,
}: {
  label: string;
  prefix?: string;
  suffix?: string;
  value: number;
  onChange: (next: number) => void;
  help: string;
  step?: number;
  // Per-field min/max so browser-native spinner + native validation
  // match the explicit validateYieldDrift bounds (e.g. minDriftBps ≥ 1,
  // sustainHours ≤ 168). Without these, the spinner happily walks
  // values down to 0 or up to the JS-Number ceiling.
  min?: number;
  max?: number;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      <InputGroup className={cn('w-full')}>
        {prefix && <InputGroupAddon>{prefix}</InputGroupAddon>}
        <InputGroupInput
          id={id}
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? String(value) : ''}
          step={step ?? 'any'}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          }}
        />
        {suffix && <InputGroupText>{suffix}</InputGroupText>}
      </InputGroup>
      <p className="text-muted-foreground text-xs">{help}</p>
    </div>
  );
}
