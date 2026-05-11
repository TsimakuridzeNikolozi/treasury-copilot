import { Connection, PublicKey } from '@solana/web3.js';
import {
  type AlertSubscriptionRow,
  getLastWalletOutflowAt,
  getLatestApy,
  getPolicy,
  getTreasuryForRouting,
  listEnabled,
  readIdleCapitalConfig,
} from '@tc/db';
import { getWalletUsdcBalance } from '@tc/protocols/usdc';
import type { Venue } from '@tc/types';
import Decimal from 'decimal.js';
import { db } from '../db';
import { env } from '../env';
import { sendTelegramNotification } from '../notifications';

// Same module-scoped lazy Connection pattern as collect-apy-snapshots and
// check-yield-drift. Reads are one-shot HTTP RPC; the sentinel wsEndpoint
// makes accidental subscription paths fail loudly.
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

const VENUE_LABEL: Record<Venue, string> = {
  kamino: 'Kamino',
  save: 'Save',
  jupiter: 'Jupiter Lend',
  drift: 'Drift',
  marginfi: 'Marginfi',
};

interface IdleSignal {
  walletAddress: string;
  idleUsdc: Decimal;
  dwellHours: number;
  bestVenue: Venue;
  bestApyDecimal: number;
  opportunityUsdcPerMonth: Decimal;
}

function fmtUsdcWhole(d: Decimal): string {
  return d.toNumber().toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Best (highest) latest APY across the venues currently allowed by policy
// AND covered by apy_snapshots. Skips venues with no snapshot yet (fresh
// install, or a venue whose collector hasn't ticked) rather than picking
// arbitrary values. Returns null when nothing usable is in the series —
// the nudge then no-ops for that treasury.
async function pickBestVenueApy(
  allowedVenues: readonly Venue[],
): Promise<{ venue: Venue; apyDecimal: number } | null> {
  const rows = await Promise.all(
    allowedVenues.map(async (venue) => {
      const row = await getLatestApy(db, venue);
      if (!row) return null;
      const n = Number.parseFloat(row.apyDecimal);
      return Number.isFinite(n) && n > 0 ? { venue, apyDecimal: n } : null;
    }),
  );
  const candidates = rows.filter((r): r is { venue: Venue; apyDecimal: number } => r !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => (cur.apyDecimal > best.apyDecimal ? cur : best));
}

// Render the body. HTML — matches sendPlainMessage's parse mode. Suggests
// depositing the full idle balance; the user can edit the amount when
// they reply (this is a copy-paste starter, not a binding amount).
//
// Two amount formats are deliberate:
//   - `idleFormatted` ("45,000") for the human-readable body.
//   - `idleRaw` ("45000") for the CTA's <code> block, so a verbatim
//     paste into chat survives the proposeDeposit tool's amountUsdc
//     regex (`^\d+(\.\d+)?$`). Locale commas would break it.
function renderBody(signal: IdleSignal): string {
  const idleFormatted = fmtUsdcWhole(signal.idleUsdc);
  const idleRaw = signal.idleUsdc.toFixed(0);
  const opp = fmtUsdcWhole(signal.opportunityUsdcPerMonth);
  const days = Math.floor(signal.dwellHours / 24);
  const dwellLabel = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${signal.dwellHours}h`;
  const apyPct = (signal.bestApyDecimal * 100).toFixed(2);
  return [
    '<b>Idle USDC</b>',
    `~$${idleFormatted} has sat in your wallet for ${dwellLabel}.`,
    `At ${VENUE_LABEL[signal.bestVenue]}'s current ${apyPct}% APY that's ~$${opp}/mo of yield foregone.`,
    '',
    `Reply in chat: <code>deposit ${idleRaw} to ${signal.bestVenue}</code>`,
  ].join('\n');
}

// Per-treasury check. Sequential RPC reads on a single Connection so a
// slow one doesn't fan out into concurrent socket pressure. Errors bubble
// up to the outer try/catch in checkIdleCapital so one bad treasury
// doesn't drop the rest.
async function checkTreasury(subscription: AlertSubscriptionRow): Promise<void> {
  const treasuryId = subscription.treasuryId;
  const treasury = await getTreasuryForRouting(db, treasuryId);
  if (!treasury) {
    console.warn(`[check-idle-capital] treasury ${treasuryId} not found; skipping`);
    return;
  }
  const config = readIdleCapitalConfig(subscription);

  // 1. Read wallet balance. A flaky RPC here aborts THIS treasury only.
  const conn = getConnection();
  const owner = new PublicKey(treasury.walletAddress);
  const wallet = await getWalletUsdcBalance(conn, owner);
  const idleUsdc = new Decimal(wallet.amountUsdc);
  if (idleUsdc.lt(config.minIdleUsdc)) return;

  // 2. Dwell. Compare against MAX(treasury.created_at, lastOutflowAt) —
  //    without the treasury floor, brand-new treasuries (no actions yet)
  //    would fire immediately as soon as they're funded, which is the
  //    opposite of "idle" (it's "just funded, give the user time").
  const lastOutflowAt = await getLastWalletOutflowAt(db, treasuryId);
  const anchorMs = Math.max(
    treasury.createdAt.getTime(),
    lastOutflowAt ? lastOutflowAt.getTime() : 0,
  );
  const dwellMs = Date.now() - anchorMs;
  const dwellHours = dwellMs / 3_600_000;
  if (dwellHours < config.minDwellHours) return;

  // 3. Best venue APY. If no usable snapshot exists for any allowed
  //    venue, we have nothing to suggest — bail.
  const policy = await getPolicy(db, treasuryId);
  const best = await pickBestVenueApy(policy.allowedVenues);
  if (!best) return;

  // 4. Opportunity cost = idle × APY × 30/365. Same shape as yield-drift.
  const opportunityUsdcPerMonth = idleUsdc.mul(new Decimal(best.apyDecimal)).mul(30).div(365);

  const signal: IdleSignal = {
    walletAddress: treasury.walletAddress,
    idleUsdc,
    dwellHours: Math.round(dwellHours),
    bestVenue: best.venue,
    bestApyDecimal: best.apyDecimal,
    opportunityUsdcPerMonth,
  };

  const cooldownMs = config.cooldownHours * 3_600_000;
  const result = await sendTelegramNotification({
    treasuryId,
    kind: 'idle_capital',
    body: renderBody(signal),
    // Dedupe per wallet address (not per treasury id) so an owner who
    // recycles the same wallet between treasury rows still gets the
    // cooldown. In practice wallet ↔ treasury is 1:1 today; the keying
    // is just defense-in-depth.
    dedupeKey: `idle_capital:${treasury.walletAddress}`,
    dedupeWindowMs: cooldownMs,
    payload: {
      walletAddress: signal.walletAddress,
      idleUsdc: signal.idleUsdc.toFixed(6),
      dwellHours: signal.dwellHours,
      bestVenue: signal.bestVenue,
      bestApyDecimal: signal.bestApyDecimal,
      opportunityUsdcPerMonth: signal.opportunityUsdcPerMonth.toFixed(6),
    },
  });
  if (result.status === 'failed') {
    console.warn(`[check-idle-capital] ${treasuryId} notify failed: ${result.reason}`);
  }
}

// One check pass. Sequential per-treasury to keep RPC fan-out bounded —
// at daily cadence the loop has plenty of time.
export async function checkIdleCapital(): Promise<void> {
  const enabled = await listEnabled(db, 'idle_capital');
  if (enabled.length === 0) return;
  for (const row of enabled) {
    try {
      await checkTreasury(row);
    } catch (err) {
      console.error(`[check-idle-capital] ${row.treasuryId} failed:`, err);
    }
  }
}
