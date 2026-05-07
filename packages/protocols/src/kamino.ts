import {
  PROGRAM_ID as KLEND_PROGRAM_ID,
  KaminoAction,
  KaminoMarket,
  VanillaObligation,
} from '@kamino-finance/klend-sdk';
import {
  type Commitment,
  type Connection,
  PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { DepositAction } from '@tc/types';
import BN from 'bn.js';
import Decimal from 'decimal.js';

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

export interface KaminoCtx {
  connection: Connection;
  owner: PublicKey;
}

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
function withFinalizedSlot(connection: Connection): Connection {
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
// Only deposit is wired in 2B; withdraw, rebalance, and other venues fall
// through to the smoke transfer in the signer.
export async function buildKaminoDepositInstructions(
  action: DepositAction,
  ctx: KaminoCtx,
): Promise<TransactionInstruction[]> {
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
  const baseUnits = new BN(
    new Decimal(action.amountUsdc).mul(new Decimal(10).pow(USDC_DECIMALS)).toFixed(0),
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

  return [
    ...kaminoAction.computeBudgetIxs,
    ...kaminoAction.setupIxs,
    ...kaminoAction.lendingIxs,
    ...kaminoAction.cleanupIxs,
  ];
}
