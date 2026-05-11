import { Connection, PublicKey } from '@solana/web3.js';
import {
  type AlertSubscriptionRow,
  getAvgApy,
  getLatestApy,
  getPolicy,
  getTreasuryForRouting,
  listEnabled,
  readYieldDriftConfig,
} from '@tc/db';
import { jupiter, kamino, save } from '@tc/protocols';
import type { Venue } from '@tc/types';
import Decimal from 'decimal.js';
import { db } from '../db';
import { env } from '../env';
import { sendTelegramNotification } from '../notifications';

// Mirrors collect-apy-snapshots.ts's module-scoped lazy Connection. The
// readers used here are one-shot HTTP RPC calls only; we pin a sentinel
// wsEndpoint so a future contributor who adds a subscription path fails
// loudly instead of silently opening a socket that prevents clean
// shutdown.
let connection: Connection | null = null;
function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: 'ws://disabled-no-subscriptions-used',
    });
  }
  return connection;
}

// Venues with both a position reader AND a wired rebalance leg (deposit +
// withdraw). The drift suggestion is "rebalance from heldVenue to altVenue"
// — if the alt has no deposit builder we can't honour that suggestion.
// Today: kamino, save, jupiter all qualify; drift / marginfi don't ship
// builders so they wouldn't be in policy.allowedVenues either.
const POSITION_READERS: ReadonlyArray<{
  venue: Venue;
  read: (connection: Connection, owner: PublicKey) => Promise<{ amountUsdc: string }>;
}> = [
  { venue: 'kamino', read: kamino.getKaminoUsdcPosition },
  { venue: 'save', read: save.getSaveUsdcPosition },
  { venue: 'jupiter', read: jupiter.getJupiterUsdcPosition },
];

// Pretty venue labels for the Telegram body. Lower-case keys map to the
// presentation form users see in the rest of the UI (chat, settings).
const VENUE_LABEL: Record<Venue, string> = {
  kamino: 'Kamino',
  save: 'Save',
  jupiter: 'Jupiter Lend',
  drift: 'Drift',
  marginfi: 'Marginfi',
};

interface DriftSignal {
  heldVenue: Venue;
  altVenue: Venue;
  positionUsdc: Decimal;
  driftBps: number;
  // The window the avg-vs-avg comparison used. Surfaced in the message
  // body so a user with a non-default sustainHours sees the correct
  // "last Nh" phrasing instead of a hardcoded "24h".
  sustainHours: number;
  // Projected monthly opportunity cost in USDC if the user did nothing.
  // = position × driftDecimal × (30/365) — same shape the plan called out.
  opportunityUsdcPerMonth: Decimal;
  heldAvgApy: number;
  altAvgApy: number;
  heldLatestApy: number;
  altLatestApy: number;
}

// Format USDC for the Telegram body. Position amounts are typically in the
// thousands; rendering with commas and dropping fractional pennies keeps
// the message readable. toNumber() is lossy at the JS Number boundary, but
// fine here — the formatter immediately drops sub-dollar precision anyway,
// and treasury positions in the 2^53 USDC range are not a realistic case.
function fmtUsdc(d: Decimal): string {
  return d.toNumber().toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Compute the drift signal between a held venue and a candidate alt, if
// both conditions hold:
//   1. Sustained: avg(alt - held) over `sustainHours` ≥ minDriftBps.
//   2. Currently active: latest(alt) > latest(held) (still profitable now).
// Returns null when either condition fails or any snapshot is missing.
async function evaluateDriftPair(
  heldVenue: Venue,
  altVenue: Venue,
  positionUsdc: Decimal,
  sustainHours: number,
  minDriftBps: number,
): Promise<DriftSignal | null> {
  const since = new Date(Date.now() - sustainHours * 3_600_000);
  const [heldAvg, altAvg, heldLatest, altLatest] = await Promise.all([
    getAvgApy(db, heldVenue, since),
    getAvgApy(db, altVenue, since),
    getLatestApy(db, heldVenue),
    getLatestApy(db, altVenue),
  ]);
  if (heldAvg == null || altAvg == null || !heldLatest || !altLatest) {
    // Not enough history yet (first run, or a venue whose collector hasn't
    // populated the window). Bail quietly.
    return null;
  }
  const heldLatestApy = Number.parseFloat(heldLatest.apyDecimal);
  const altLatestApy = Number.parseFloat(altLatest.apyDecimal);
  if (!Number.isFinite(heldLatestApy) || !Number.isFinite(altLatestApy)) {
    return null;
  }
  // Sustained: avg(alt) − avg(held) over the window, expressed in bps.
  const sustainedDriftDecimal = altAvg - heldAvg;
  const sustainedDriftBps = sustainedDriftDecimal * 10_000;
  if (sustainedDriftBps < minDriftBps) return null;
  // Active: latest spot still favours the alt. Without this, a drift that
  // existed yesterday but reversed today would still fire — wasting the
  // user's attention.
  if (altLatestApy <= heldLatestApy) return null;

  // Opportunity cost uses the SUSTAINED drift (more conservative than spot;
  // matches the avg the user just read in the message).
  const driftDecimal = new Decimal(sustainedDriftDecimal);
  const opportunityUsdcPerMonth = positionUsdc.mul(driftDecimal).mul(30).div(365);

  return {
    heldVenue,
    altVenue,
    positionUsdc,
    driftBps: Math.round(sustainedDriftBps),
    sustainHours,
    opportunityUsdcPerMonth,
    heldAvgApy: heldAvg,
    altAvgApy: altAvg,
    heldLatestApy,
    altLatestApy,
  };
}

// Render the alert body. Plain HTML — the dispatcher (sendPlainMessage)
// uses parse_mode='HTML', same as the approval cards.
function renderBody(signal: DriftSignal): string {
  const heldLabel = VENUE_LABEL[signal.heldVenue];
  const altLabel = VENUE_LABEL[signal.altVenue];
  const opportunity = fmtUsdc(signal.opportunityUsdcPerMonth);
  const position = fmtUsdc(signal.positionUsdc);
  const windowLabel = signal.sustainHours === 24 ? 'last 24h' : `last ${signal.sustainHours}h`;
  return [
    '<b>Yield drift detected</b>',
    `${heldLabel} USDC is ${signal.driftBps}bps below ${altLabel} over the ${windowLabel}.`,
    `Your ~$${position} position is leaving ~$${opportunity}/mo on the table at current rates.`,
    '',
    `Reply in chat: <code>rebalance from ${signal.heldVenue} to ${signal.altVenue}</code>`,
  ].join('\n');
}

// Per-treasury check. Pulled out so the outer loop's error boundary is one
// try/catch per treasury — a position-read crash on treasury A doesn't
// drop the check for treasury B. Takes the AlertSubscriptionRow already
// loaded by listEnabled (rather than re-fetching by id) so the hot path
// is one DB round-trip lighter per treasury per tick.
async function checkTreasury(subscription: AlertSubscriptionRow): Promise<void> {
  const treasuryId = subscription.treasuryId;
  const treasury = await getTreasuryForRouting(db, treasuryId);
  if (!treasury) {
    console.warn(`[check-yield-drift] treasury ${treasuryId} not found; skipping`);
    return;
  }
  const config = readYieldDriftConfig(subscription);

  const policy = await getPolicy(db, treasuryId);
  const allowedVenues = policy.allowedVenues.filter((v) =>
    POSITION_READERS.some((r) => r.venue === v),
  );
  if (allowedVenues.length < 2) return; // Nothing to drift to / from.

  // Read positions for all allowed venues. Per-venue try/catch so a flaky
  // SDK (jupiter is pre-1.0) doesn't take down the whole check.
  const owner = new PublicKey(treasury.walletAddress);
  const conn = getConnection();
  const positions: Array<{ venue: Venue; amount: Decimal }> = [];
  for (const venue of allowedVenues) {
    const reader = POSITION_READERS.find((r) => r.venue === venue);
    if (!reader) continue;
    try {
      const r = await reader.read(conn, owner);
      const amount = new Decimal(r.amountUsdc);
      if (amount.gt(0)) positions.push({ venue, amount });
    } catch (err) {
      console.warn(`[check-yield-drift] ${treasuryId} ${venue} position read failed:`, err);
    }
  }
  if (positions.length === 0) return; // No positions to drift away from.

  // For each held position, check drift vs every other allowed venue.
  const cooldownMs = config.cooldownHours * 3_600_000;
  for (const held of positions) {
    for (const altVenue of allowedVenues) {
      if (altVenue === held.venue) continue;
      const signal = await evaluateDriftPair(
        held.venue,
        altVenue,
        held.amount,
        config.sustainHours,
        config.minDriftBps,
      );
      if (!signal) continue;
      if (signal.opportunityUsdcPerMonth.lt(config.minOpportunityUsdcPerMonth)) continue;

      const result = await sendTelegramNotification({
        treasuryId,
        kind: 'yield_drift',
        body: renderBody(signal),
        dedupeKey: `yield_drift:${signal.heldVenue}:${signal.altVenue}`,
        dedupeWindowMs: cooldownMs,
        payload: {
          heldVenue: signal.heldVenue,
          altVenue: signal.altVenue,
          driftBps: signal.driftBps,
          positionUsdc: signal.positionUsdc.toFixed(6),
          opportunityUsdcPerMonth: signal.opportunityUsdcPerMonth.toFixed(6),
          heldAvgApy: signal.heldAvgApy,
          altAvgApy: signal.altAvgApy,
          heldLatestApy: signal.heldLatestApy,
          altLatestApy: signal.altLatestApy,
        },
      });
      if (result.status === 'failed') {
        console.warn(
          `[check-yield-drift] ${treasuryId} ${signal.heldVenue}→${signal.altVenue} notify failed: ${result.reason}`,
        );
      }
    }
  }
}

// One check pass. Each treasury runs in its own try/catch so one bad row
// doesn't drop the rest. Sequential per-treasury to keep RPC fan-out
// bounded — drift checks are cheap relative to the 6h cadence.
export async function checkYieldDrift(): Promise<void> {
  const enabled = await listEnabled(db, 'yield_drift');
  if (enabled.length === 0) return;
  for (const row of enabled) {
    try {
      await checkTreasury(row);
    } catch (err) {
      console.error(`[check-yield-drift] ${row.treasuryId} failed:`, err);
    }
  }
}
