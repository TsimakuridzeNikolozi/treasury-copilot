import {
  PROGRAM_ID as KLEND_PROGRAM_ID,
  KaminoAction,
  KaminoMarket,
  VanillaObligation,
} from '@kamino-finance/klend-sdk';
import { type Commitment, type Connection, PublicKey } from '@solana/web3.js';
import type { DepositAction, WithdrawAction } from '@tc/types';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import type { BuiltInstructions, ProtocolCtx } from './types';

// Kamino Main Market on mainnet (USDC, SOL, JitoSOL, …). Pinned here so the
// signer doesn't reach into SDK internals or the Kamino CDN at runtime.
// Source: https://docs.kamino.finance/ + on-chain config.
//
// TODO: when we add devnet / test markets, move these constants into a
// KaminoConfig argument so callers (and tests) can supply alternates without
// editing this file.
export const KAMINO_MAIN_MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');

// Re-exported so the signer's allowlist can reference it without importing
// from klend-sdk directly.
export const KLEND_PROGRAM_ID_BASE58 = KLEND_PROGRAM_ID.toBase58();

// Mainnet USDC mint — same address as on Solana's official token list.
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDC_DECIMALS = 6;

// Approximate mainnet slot time used by the SDK for stale-price calculations.
// Real slot time fluctuates ~380–450ms; this is a reasonable midpoint.
const RECENT_SLOT_DURATION_MS = 450;

// Alias maintained for backwards compatibility within this file.
// Other protocol builders should import ProtocolCtx from './types' directly.
export type KaminoCtx = ProtocolCtx;

// Wrap a Connection so any `getSlot()` the Kamino SDK makes uses `finalized`
// commitment. The SDK bakes the result into `CreateLookupTable.recentSlot`
// during first-time user setup; that slot must be in the runtime's SlotHashes
// sysvar (last ~512 confirmed slots) when the tx executes. Public RPCs often
// return a `processed` slot that the leader processing our tx hasn't seen yet,
// causing "X is not a recent slot" failures. Finalized slots are guaranteed
// to be in SlotHashes cluster-wide.
//
// Object.create gives us a wrapper that inherits all Connection methods via
// prototype chain — no need to re-implement the surface — and overriding
// `getSlot` here shadows the inherited method only for that one call.
//
// Exported because Save's setup ixs may also include a CreateLookupTable
// with the same stale-slot risk; the wrapping is venue-agnostic.
export function withFinalizedSlot(connection: Connection): Connection {
  const wrapped = Object.create(connection) as Connection;
  wrapped.getSlot = (commitmentOrConfig?: Commitment | { commitment?: Commitment }) => {
    const finalized: Commitment = 'finalized';
    if (commitmentOrConfig === undefined || typeof commitmentOrConfig === 'string') {
      return connection.getSlot(finalized);
    }
    return connection.getSlot({ ...commitmentOrConfig, commitment: finalized });
  };
  return wrapped;
}

// Builds the full instruction set for a USDC deposit into Kamino Main Market.
// Returns instructions in submission order: compute-budget, setup (ATA + price
// refresh + obligation init if needed), lending (the actual deposit), cleanup.
//
// `includeAtaIxs=true` so a treasury without a USDC ATA gets one auto-created
// in the same tx — first deposits don't fail with "ATA not found".
//
// Deposit and withdraw are both wired today; rebalance is decomposed by the
// executor into two single-leg allow decisions.
export async function buildKaminoDepositInstructions(
  action: DepositAction,
  ctx: KaminoCtx,
): Promise<BuiltInstructions> {
  const connection = withFinalizedSlot(ctx.connection);

  // TODO: KaminoMarket.load fetches market + reserves on every invocation
  // (≥1 RPC roundtrip, ~100–300ms). Once volume justifies it, cache the
  // market with a TTL inside this module — premature for now.
  const market = await KaminoMarket.load(
    connection,
    KAMINO_MAIN_MARKET,
    RECENT_SLOT_DURATION_MS,
    KLEND_PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Kamino market ${KAMINO_MAIN_MARKET.toBase58()} did not load`);
  }

  // amountUsdc is a decimal string ("5.0"); SDK takes base units (BN).
  // Validate before converting: silently rounding sub-base-unit precision
  // would over-deposit (default toFixed rounds half-up), and a negative or
  // non-finite amount must never reach the SDK.
  const amount = new Decimal(action.amountUsdc);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new Error(`invalid amountUsdc: ${action.amountUsdc}`);
  }
  if (amount.decimalPlaces() > USDC_DECIMALS) {
    throw new Error(
      `amountUsdc ${action.amountUsdc} exceeds USDC precision (${USDC_DECIMALS} decimals)`,
    );
  }
  const baseUnits = new BN(
    amount.mul(new Decimal(10).pow(USDC_DECIMALS)).toFixed(0, Decimal.ROUND_DOWN),
  );

  // useV2Ixs=true selects the V2 lending instruction format (supports
  // elevation groups, etc.). It does NOT skip per-user LUT setup — the SDK
  // still puts a CreateLookupTable in setupIxs the first time a user touches
  // Kamino. That LUT setup's stale-slot risk is mitigated by withFinalizedSlot
  // above; once the user's metadata + LUT are initialized on-chain, future
  // deposits skip this setup path entirely.
  const kaminoAction = await KaminoAction.buildDepositTxns(
    market,
    baseUnits,
    USDC_MINT,
    ctx.owner,
    new VanillaObligation(KLEND_PROGRAM_ID),
    /* useV2Ixs */ true,
    /* scopeRefreshConfig */ undefined,
    /* extraComputeBudget */ 1_000_000,
    /* includeAtaIxs */ true,
    /* requestElevationGroup */ false,
  );

  return {
    instructions: [
      ...kaminoAction.computeBudgetIxs,
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ],
    extraSigners: [],
  };
}

// Mirror of buildKaminoDepositInstructions for withdrawals from the same
// reserve. Requires the owner to have an existing obligation (created by a
// prior deposit); if not, KaminoAction.buildWithdrawTxns errors and the
// signer surfaces it as ExecuteResult.failure.
//
// TODO: phase-2 reads will introduce a "max withdraw" flow. The SDK's
// max-withdraw sentinel is U64_MAX (= "18446744073709551615"); pass that as
// the `amount` arg to drain the reserve and (optionally) close the obligation.
// Not exposed in WithdrawAction yet — defer until we can read positions.
export async function buildKaminoWithdrawInstructions(
  action: WithdrawAction,
  ctx: KaminoCtx,
): Promise<BuiltInstructions> {
  const connection = withFinalizedSlot(ctx.connection);

  const market = await KaminoMarket.load(
    connection,
    KAMINO_MAIN_MARKET,
    RECENT_SLOT_DURATION_MS,
    KLEND_PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Kamino market ${KAMINO_MAIN_MARKET.toBase58()} did not load`);
  }

  // Same validation + ROUND_DOWN conversion as deposit. Two duplicated copies
  // is fine for now; if a third venue grows the same shape, extract a helper.
  const amount = new Decimal(action.amountUsdc);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new Error(`invalid amountUsdc: ${action.amountUsdc}`);
  }
  if (amount.decimalPlaces() > USDC_DECIMALS) {
    throw new Error(
      `amountUsdc ${action.amountUsdc} exceeds USDC precision (${USDC_DECIMALS} decimals)`,
    );
  }
  const baseUnits = new BN(
    amount.mul(new Decimal(10).pow(USDC_DECIMALS)).toFixed(0, Decimal.ROUND_DOWN),
  );

  const kaminoAction = await KaminoAction.buildWithdrawTxns(
    market,
    baseUnits,
    USDC_MINT,
    ctx.owner,
    new VanillaObligation(KLEND_PROGRAM_ID),
    /* useV2Ixs */ true,
    /* scopeRefreshConfig */ undefined,
    /* extraComputeBudget */ 1_000_000,
    /* includeAtaIxs */ true,
    /* requestElevationGroup */ false,
  );

  return {
    instructions: [
      ...kaminoAction.computeBudgetIxs,
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ],
    extraSigners: [],
  };
}

// Format a human-USDC Decimal (already divided by 10^decimals) into a string
// with up to 6 fraction digits, trailing zeros trimmed. Mirrors the rendering
// shape of ProposedAction.amountUsdc so chat tool output is interchangeable.
function formatUsdcHuman(amount: Decimal): string {
  if (amount.lte(0)) return '0';
  return amount.toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
}

// Fetch the current supply APY for the USDC reserve in Kamino Main Market as
// a decimal (e.g. 0.0523 for 5.23%). KaminoMarket.load is ~1 RPC;
// totalSupplyAPY is a pure function of reserve state + slot. No caching —
// chat tool calls this once per snapshot.
export async function getKaminoUsdcSupplyApy(
  connection: Connection,
): Promise<{ apyDecimal: number }> {
  const market = await KaminoMarket.load(
    connection,
    KAMINO_MAIN_MARKET,
    RECENT_SLOT_DURATION_MS,
    KLEND_PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Kamino market ${KAMINO_MAIN_MARKET.toBase58()} did not load`);
  }
  const reserve = market.getReserveByMint(USDC_MINT);
  if (!reserve) {
    throw new Error(`USDC reserve not found in Kamino market ${KAMINO_MAIN_MARKET.toBase58()}`);
  }
  const slot = await connection.getSlot('confirmed');
  return { apyDecimal: reserve.totalSupplyAPY(slot) };
}

// Fetch how much USDC `owner` has supplied into Kamino Main Market's USDC
// reserve. Returns '0' if the owner has no obligation yet (first read before
// any deposit). Decimal-USDC string, 6-digit precision, trailing zeros trimmed.
export async function getKaminoUsdcPosition(
  connection: Connection,
  owner: PublicKey,
): Promise<{ amountUsdc: string }> {
  const market = await KaminoMarket.load(
    connection,
    KAMINO_MAIN_MARKET,
    RECENT_SLOT_DURATION_MS,
    KLEND_PROGRAM_ID,
  );
  if (!market) {
    throw new Error(`Kamino market ${KAMINO_MAIN_MARKET.toBase58()} did not load`);
  }
  const obligation = await market.getObligationByWallet(
    owner,
    new VanillaObligation(KLEND_PROGRAM_ID),
  );
  if (!obligation) {
    return { amountUsdc: '0' };
  }
  const reserve = market.getReserveByMint(USDC_MINT);
  if (!reserve) {
    throw new Error(`USDC reserve not found in Kamino market ${KAMINO_MAIN_MARKET.toBase58()}`);
  }
  // getDepositAmountByReserve already divides by mint factor, so the value is
  // human-USDC (e.g. 0.75), not base units.
  return { amountUsdc: formatUsdcHuman(obligation.getDepositAmountByReserve(reserve)) };
}
