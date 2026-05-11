import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../client';
import { type AlertSubscriptionRow, alertSubscriptions, auditLogs } from '../schema';

// String literals (not a TS enum) so that adding a new kind is a single
// edit at the DB CHECK + this union. Mirrors `audit_logs.kind` and
// `notifications.kind`'s text-with-call-site-literals convention.
export type AlertKind =
  | 'yield_drift'
  | 'idle_capital'
  | 'anomaly'
  | 'concentration'
  | 'protocol_health';

// Per-alert config shapes. Each downstream PR (M3-3 idle, M3-5 anomaly,
// M5-1 concentration, M5-2 protocol_health) widens these. The runtime
// validates against these shapes at PATCH time; the migration only
// seeds yield_drift with concrete defaults (others get `{}` and are
// filled when their PR lands).
export interface YieldDriftConfig {
  minDriftBps: number;
  minOpportunityUsdcPerMonth: number;
  sustainHours: number;
  cooldownHours: number;
}

export const YIELD_DRIFT_DEFAULT_CONFIG: YieldDriftConfig = {
  minDriftBps: 100,
  minOpportunityUsdcPerMonth: 25,
  sustainHours: 24,
  cooldownHours: 24,
};

// M3 PR 3 — idle-capital nudge config.
//   minIdleUsdc    — don't ping below this much USDC sitting in wallet.
//                    Filters out dev wallets / petty cash.
//   minDwellHours  — how long the balance must have sat (no qualifying
//                    outflow) before counting as "idle". Default 3 days.
//   cooldownHours  — don't re-ping the same wallet within this window
//                    after an alert. Default 2 days.
export interface IdleCapitalConfig {
  minIdleUsdc: number;
  minDwellHours: number;
  cooldownHours: number;
}

export const IDLE_CAPITAL_DEFAULT_CONFIG: IdleCapitalConfig = {
  minIdleUsdc: 5000,
  minDwellHours: 72,
  cooldownHours: 48,
};

// Get one subscription. Returns null when the row hasn't been seeded yet
// — fresh treasuries created between the migration and a worker tick
// fall into this case. Callers that want a usable shape (the worker job
// loop, the form's initial render) should pass through
// `getSubscriptionOrDefault` instead.
export async function getSubscription(
  db: Db,
  treasuryId: string,
  kind: AlertKind,
): Promise<AlertSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.treasuryId, treasuryId), eq(alertSubscriptions.kind, kind)))
    .limit(1);
  return row ?? null;
}

// List every (kind, row) for a treasury. Settings form reads this to
// render its toggle table. Stable ordering by `kind` keeps the form's
// DOM order deterministic for diffing.
export async function listSubscriptions(
  db: Db,
  treasuryId: string,
): Promise<AlertSubscriptionRow[]> {
  return db
    .select()
    .from(alertSubscriptions)
    .where(eq(alertSubscriptions.treasuryId, treasuryId))
    .orderBy(alertSubscriptions.kind);
}

// Enabled rows across all treasuries for a kind. The worker's per-kind
// check job (e.g. check-yield-drift) loops over this list. Returning the
// raw row gives the job both `treasuryId` and `config`.
export async function listEnabled(db: Db, kind: AlertKind): Promise<AlertSubscriptionRow[]> {
  return db
    .select()
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.kind, kind), eq(alertSubscriptions.enabled, true)));
}

export interface UpsertSubscriptionInput {
  treasuryId: string;
  kind: AlertKind;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedBy: string;
}

// Atomic update + audit. Audit row uses kind = 'alert_subscription_updated'
// with { before, after, kind } payload — same shape as policy_updated.
export async function upsertSubscription(db: Db, input: UpsertSubscriptionInput): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const before = await tx.query.alertSubscriptions.findFirst({
      where: and(
        eq(alertSubscriptions.treasuryId, input.treasuryId),
        eq(alertSubscriptions.kind, input.kind),
      ),
    });

    await tx
      .insert(alertSubscriptions)
      .values({
        treasuryId: input.treasuryId,
        kind: input.kind,
        enabled: input.enabled,
        config: input.config,
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [alertSubscriptions.treasuryId, alertSubscriptions.kind],
        set: {
          enabled: input.enabled,
          config: input.config,
          updatedBy: input.updatedBy,
          updatedAt: now,
        },
      });

    await tx.insert(auditLogs).values({
      kind: 'alert_subscription_updated',
      treasuryId: input.treasuryId,
      actor: input.updatedBy,
      payload: {
        kind: input.kind,
        before: before ? { enabled: before.enabled, config: before.config } : null,
        after: { enabled: input.enabled, config: input.config },
      },
    });
  });
}

// Convenience for the worker job: fetch config typed as YieldDriftConfig,
// falling back to the in-source defaults if the row is missing or the
// jsonb is partial (e.g. a future field added in code before a backfill).
export function readYieldDriftConfig(row: AlertSubscriptionRow | null): YieldDriftConfig {
  const raw = (row?.config ?? {}) as Partial<YieldDriftConfig>;
  return {
    minDriftBps:
      typeof raw.minDriftBps === 'number' && Number.isFinite(raw.minDriftBps)
        ? raw.minDriftBps
        : YIELD_DRIFT_DEFAULT_CONFIG.minDriftBps,
    minOpportunityUsdcPerMonth:
      typeof raw.minOpportunityUsdcPerMonth === 'number' &&
      Number.isFinite(raw.minOpportunityUsdcPerMonth)
        ? raw.minOpportunityUsdcPerMonth
        : YIELD_DRIFT_DEFAULT_CONFIG.minOpportunityUsdcPerMonth,
    sustainHours:
      typeof raw.sustainHours === 'number' && Number.isFinite(raw.sustainHours)
        ? raw.sustainHours
        : YIELD_DRIFT_DEFAULT_CONFIG.sustainHours,
    cooldownHours:
      typeof raw.cooldownHours === 'number' && Number.isFinite(raw.cooldownHours)
        ? raw.cooldownHours
        : YIELD_DRIFT_DEFAULT_CONFIG.cooldownHours,
  };
}

// Same field-level fallback pattern as readYieldDriftConfig: partial
// jsonb (a future schema widening before a backfill) falls back to the
// in-source defaults so the worker is never reading garbage.
export function readIdleCapitalConfig(row: AlertSubscriptionRow | null): IdleCapitalConfig {
  const raw = (row?.config ?? {}) as Partial<IdleCapitalConfig>;
  return {
    minIdleUsdc:
      typeof raw.minIdleUsdc === 'number' && Number.isFinite(raw.minIdleUsdc)
        ? raw.minIdleUsdc
        : IDLE_CAPITAL_DEFAULT_CONFIG.minIdleUsdc,
    minDwellHours:
      typeof raw.minDwellHours === 'number' && Number.isFinite(raw.minDwellHours)
        ? raw.minDwellHours
        : IDLE_CAPITAL_DEFAULT_CONFIG.minDwellHours,
    cooldownHours:
      typeof raw.cooldownHours === 'number' && Number.isFinite(raw.cooldownHours)
        ? raw.cooldownHours
        : IDLE_CAPITAL_DEFAULT_CONFIG.cooldownHours,
  };
}

// Idempotent "seed if missing" helper. The 0010 migration backfills every
// existing treasury, but a treasury created later (after the migration ran)
// has no row until its first edit. The settings page calls this on render
// so the form always has a baseline to dirty-check against, and the worker
// loop (which iterates `listEnabled`) never has to defensively handle
// "row was missing".
//
// Why not a DB trigger on treasuries insert: keeps trigger surface zero
// for the project, and the on-render call has near-zero cost (one
// upsert-on-conflict-do-nothing per missing kind per render).
export async function ensureSubscriptionsForTreasury(
  db: DbOrTx,
  treasuryId: string,
): Promise<void> {
  const KINDS: ReadonlyArray<{ kind: AlertKind; config: Record<string, unknown> }> = [
    { kind: 'yield_drift', config: { ...YIELD_DRIFT_DEFAULT_CONFIG } },
    { kind: 'idle_capital', config: { ...IDLE_CAPITAL_DEFAULT_CONFIG } },
    { kind: 'anomaly', config: {} },
    { kind: 'concentration', config: {} },
    { kind: 'protocol_health', config: {} },
  ];
  // Parallel upserts: the 5 inserts are independent (different `kind`
  // values can't conflict on the (treasury_id, kind) unique index), so
  // running them sequentially would burn 5 round-trips per /settings
  // render. postgres-js pipelines concurrent queries on the same
  // connection, so Promise.all collapses to roughly one network turn.
  await Promise.all(
    KINDS.map(({ kind, config }) =>
      db
        .insert(alertSubscriptions)
        .values({ treasuryId, kind, enabled: false, config })
        .onConflictDoNothing({
          target: [alertSubscriptions.treasuryId, alertSubscriptions.kind],
        }),
    ),
  );
}
