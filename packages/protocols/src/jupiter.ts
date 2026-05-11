import {
  getDepositIxs,
  getLendingTokenDetails,
  getUserLendingPositionByAsset,
  getWithdrawIxs,
} from '@jup-ag/lend/earn';
import { type Connection, PublicKey } from '@solana/web3.js';
import type { DepositAction, WithdrawAction } from '@tc/types';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import type { BuiltInstructions, ProtocolCtx } from './types';

// Jupiter Lend (Earn) on Solana mainnet — receipt-token model (jlUSDC).
// Program ID pinned from the lending IDL bundled with @jup-ag/lend (the
// IDL's metadata.address field). Pinned here so the signer's allowlist
// can reference it without importing from @jup-ag/lend directly — mirrors
// the kamino.ts / save.ts pattern.
export const JUPITER_LEND_PROGRAM_ID_BASE58 = 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9';
const JUPITER_LEND_PROGRAM_ID = new PublicKey(JUPITER_LEND_PROGRAM_ID_BASE58);

// Mainnet USDC mint. Same value as in kamino.ts; kept here so this file
// reads self-contained.
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

// Derive the jlUSDC fToken mint deterministically from the underlying asset.
// Same seeds the SDK's internal `getLendingToken` helper uses
// (@jup-ag/lend/shared/...): ["f_token_mint", mint] with the lending
// program ID. Re-deriving in-process avoids one heavy `getProgramAccounts`
// call (the SDK's `getLendingTokens` does account-scan-and-filter to find
// this mint, which is fine for a UI but wasteful for our snapshot read).
const [JL_USDC_MINT] = PublicKey.findProgramAddressSync(
  [Buffer.from('f_token_mint'), USDC_MINT.toBuffer()],
  JUPITER_LEND_PROGRAM_ID,
);

// supplyRate scale: 1e4 = 100%. Inferred by reading the compiled
// @jup-ag/lend/earn/index.mjs formula
// `supplyRate = borrowRate × (1e4 - fee) × utilization / 1e4`,
// where `borrowRate` is the u16 field on `tokenReserve` (also scaled
// 1e4 = 100%). The scale is NOT a documented public API of the SDK —
// when bumping @jup-ag/lend past 0.1.9, the bumper MUST re-verify
// this constant against the new compiled source. We pin the SDK to
// exact 0.1.9 (not `^`) so the scale can't shift silently.
//
// Jupiter Lend (via Fluid) exposes the rate as APR — instantaneous
// annualized, no compounding. Kamino's totalSupplyAPY and Save's
// calculateSupplyInterest(showApy=true) both return APY. We convert
// APR → APY below so the chat snapshot's three venues are comparable.
const SUPPLY_RATE_PRECISION = 1e4;

// Validate a decimal-USDC string and convert to base units (BN). Same
// shape as the inline conversion in kamino.ts and save.ts — three near-
// duplicates is the tipping point for a shared helper, but each version
// is small and the validation differs subtly enough that copying is
// still cheaper than parameterising right now.
function toBaseUnits(amountUsdc: string): BN {
  const amount = new Decimal(amountUsdc);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new Error(`invalid amountUsdc: ${amountUsdc}`);
  }
  if (amount.decimalPlaces() > USDC_DECIMALS) {
    throw new Error(`amountUsdc ${amountUsdc} exceeds USDC precision (${USDC_DECIMALS} decimals)`);
  }
  return new BN(amount.mul(new Decimal(10).pow(USDC_DECIMALS)).toFixed(0, Decimal.ROUND_DOWN));
}

// Format a base-unit BN (USDC, 6 decimals) into a decimal-USDC string,
// trailing zeros trimmed. Mirrors kamino's formatUsdcHuman and save's
// formatUsdcAmount — kept local so callers don't accidentally pick up
// human-USDC formatting (a different scale) from one of the others.
function formatUsdcFromBaseUnits(baseUnits: BN): string {
  if (baseUnits.isZero() || baseUnits.isNeg()) return '0';
  const usdc = new Decimal(baseUnits.toString()).div(new Decimal(10).pow(USDC_DECIMALS));
  return usdc.toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
}

// Build the deposit ix set for USDC supply into Jupiter Lend Earn.
// The SDK's getDepositIxs returns [ATA-create-if-missing, deposit] —
// both addressed to user-facing programs (ATA + Jupiter Lend), no
// ephemeral signers needed. CPIs into the underlying liquidity program
// (Fluid) happen inside the deposit ix, not at the outer tx level, so
// they don't widen the signer's allowlist.
export async function buildJupiterDepositInstructions(
  action: DepositAction,
  ctx: ProtocolCtx,
): Promise<BuiltInstructions> {
  const { ixs } = await getDepositIxs({
    connection: ctx.connection,
    signer: ctx.owner,
    asset: USDC_MINT,
    amount: toBaseUnits(action.amountUsdc),
  });
  return { instructions: ixs, extraSigners: [] };
}

// Mirror of buildJupiterDepositInstructions for withdrawals. Requires the
// user to have jlUSDC shares (from a prior deposit); if zero, the deposit
// program errors and the signer surfaces it as ExecuteResult.failure.
export async function buildJupiterWithdrawInstructions(
  action: WithdrawAction,
  ctx: ProtocolCtx,
): Promise<BuiltInstructions> {
  const { ixs } = await getWithdrawIxs({
    connection: ctx.connection,
    signer: ctx.owner,
    asset: USDC_MINT,
    amount: toBaseUnits(action.amountUsdc),
  });
  return { instructions: ixs, extraSigners: [] };
}

// Convert a Jupiter Lend supplyRate BN (APR scaled SUPPLY_RATE_PRECISION =
// 1e4 = 100%) into a fractional APY decimal. Continuous-compounding
// approximation: APY = e^APR - 1, computed via Math.expm1 for precision
// at small inputs. For stablecoin-lending rate magnitudes (< 30% APR),
// this matches per-slot compounding within rounding error.
//
// Range check serves as a tripwire for SDK regressions: if @jup-ag/lend
// silently changes the supplyRate scale on a future bump, real APRs
// shift by an order of magnitude. We throw on >100% APR (or negative /
// non-finite) so the bumper sees a loud failure instead of a silently
// wrong APY in the chat snapshot. Note this check catches scale
// *expansions* (e.g. 1e4 → 1e2) but not contractions (1e4 → 1e6,
// which would just show vanishingly small rates) — integration
// testing against the Jupiter Lend UI is still the final word.
//
// Exported for unit tests; not part of the cross-package API.
export function supplyRateBnToApyDecimal(supplyRate: BN): number {
  const apr = supplyRate.toNumber() / SUPPLY_RATE_PRECISION;
  if (!Number.isFinite(apr) || apr < 0 || apr > 1) {
    throw new Error(
      `Jupiter Lend supplyRate ${supplyRate.toString()} → APR ${apr} is outside the sanity range [0, 1]. Likely the @jup-ag/lend supplyRate scale changed; re-verify SUPPLY_RATE_PRECISION against the SDK source.`,
    );
  }
  return Math.expm1(apr);
}

// Fetch the current supply APY for Jupiter Lend's USDC market as a
// fractional decimal (0.0523 = 5.23%). Same return shape as
// getKaminoUsdcSupplyApy / getSaveUsdcSupplyApy so the chat tool can
// render the three venues side-by-side.
export async function getJupiterUsdcSupplyApy(
  connection: Connection,
): Promise<{ apyDecimal: number }> {
  const details = await getLendingTokenDetails({ lendingToken: JL_USDC_MINT, connection });
  return { apyDecimal: supplyRateBnToApyDecimal(details.supplyRate) };
}

// Fetch how much USDC `owner` has supplied to Jupiter Lend's USDC market.
// Returns '0' when the owner has no jlUSDC ATA — the SDK's
// getUserLendingPositionByAsset internally try/catches missing token
// accounts and returns 0 BN, so we don't need a null-branch.
//
// `underlyingAssets` is the conversion of the user's jlUSDC shares back
// to underlying USDC at the current exchange rate (base units of USDC).
// We format to human-USDC for the BalanceReader contract — same shape
// as kamino.ts:264 and save.ts:300-301.
export async function getJupiterUsdcPosition(
  connection: Connection,
  owner: PublicKey,
): Promise<{ amountUsdc: string }> {
  const pos = await getUserLendingPositionByAsset({
    user: owner,
    asset: USDC_MINT,
    connection,
  });
  return { amountUsdc: formatUsdcFromBaseUnits(pos.underlyingAssets) };
}
