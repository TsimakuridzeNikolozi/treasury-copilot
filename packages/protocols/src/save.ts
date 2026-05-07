import {
  type Connection,
  Keypair,
  type PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  type InputReserveType,
  type InstructionWithSigners,
  MAIN_POOL_ADDRESS,
  SOLEND_PRODUCTION_PROGRAM_ID,
  type SaveWallet,
  SolendActionCore,
  WRAPPER_PROGRAM_ID,
  calculateSupplyInterest,
  fetchObligationsOfPoolByWallet,
  fetchPoolByAddress,
} from '@solendprotocol/solend-sdk';
import type { DepositAction, WithdrawAction } from '@tc/types';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { withFinalizedSlot } from './kamino';
import type { BuiltInstructions, ProtocolCtx } from './types';

// Save (the rebrand of Solend) — Main Pool, USDC reserve. Constants pinned
// so the signer doesn't depend on a runtime fetch from save.finance/api.
//
// Source: https://api.save.finance/v1/markets/configs?scope=all&deployment=production
// Discovered 2026-05-08 via the public API (see step 4 of the 2D plan).
// If Save migrates pool/reserve addresses, update here. Reserve fields are
// stable on-chain; the API is just the discovery surface.
//
// Re-exported as base58 for the signer's allowlist (avoids the signer
// depending on @solendprotocol/solend-sdk directly).
export const SAVE_PROGRAM_ID_BASE58 = SOLEND_PRODUCTION_PROGRAM_ID.toBase58();
export const SAVE_MAIN_POOL_ADDRESS_BASE58 = MAIN_POOL_ADDRESS.toBase58();
// Save's wrapper program — CPI'd by `withdrawExact` (our withdraw path)
// and `depositMaxReserveLiquidityAndObligationCollateral` (max-deposit;
// not our path today, but kept allowlisted for symmetry).
export const SAVE_WRAPPER_PROGRAM_ID_BASE58 = WRAPPER_PROGRAM_ID.toBase58();

// Mainnet USDC mint (same as Kamino's, kept locally so save.ts is
// self-contained when read).
export const USDC_MINT_BASE58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

// USDC reserve config in Save Main Pool. The full InputReserveType passed
// as the `reserve` argument to SolendActionCore.buildDepositTxns.
const SAVE_USDC_RESERVE: InputReserveType = {
  address: 'BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw',
  liquidityAddress: '8SheGtsopRUDzdiD6v6BR9a6bqZ9QwywYQY99Fp5meNf',
  cTokenMint: '993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk',
  cTokenLiquidityAddress: 'UtRy8gcEu9fCkDuUrU8EmC7Uc6FZy5NCwttzG7i6nkw',
  pythOracle: 'Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX',
  switchboardOracle: 'nu11111111111111111111111111111111111111111',
  mintAddress: USDC_MINT_BASE58,
  liquidityFeeReceiverAddress: '5Gdxn4yquneifE6uk9tK8X4CqHfWKjW2BvYU25hAykwP',
};

// Pool config. Save's refresh-reserves logic only touches reserves that
// appear in the user's obligation, so a single-reserve pool config is
// sufficient for a USDC-only treasury (see core/actions.js
// addRefreshReservesIxs). If we later supply other Save assets, extend
// `reserves` with their entries — until then keeping it minimal avoids
// hardcoding ~30 reserve configs that we never touch.
//
// SDK does not export InputPoolType, so the literal is structurally typed
// against `SolendActionCore.buildDepositTxns(pool, ...)`'s parameter.
const SAVE_MAIN_POOL = {
  address: SAVE_MAIN_POOL_ADDRESS_BASE58,
  owner: '5pHk2TmnqQzRF9L6egy5FfiyBgS7G9cMZ5RFaJAvghzw',
  name: 'main',
  authorityAddress: 'DdZR6zRFiUt4S5mg7AV1uKB2z1f1WzcNYCaTEEWPAuby',
  reserves: [
    {
      address: SAVE_USDC_RESERVE.address,
      pythOracle: SAVE_USDC_RESERVE.pythOracle,
      switchboardOracle: SAVE_USDC_RESERVE.switchboardOracle,
      mintAddress: SAVE_USDC_RESERVE.mintAddress,
      liquidityFeeReceiverAddress: SAVE_USDC_RESERVE.liquidityFeeReceiverAddress,
    },
  ],
};

// Validate + convert a decimal-USDC string into base units. Same shape as
// the inline validation in kamino.ts — duplicated deliberately. If a third
// venue grows the same shape, extract a helper.
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

// Flatten the categorized ix lists from SolendActionCore.getInstructions()
// into a single array, collecting any per-ix ephemeral signers.
//
// Order matters: oracleIxs run first to refresh prices on-chain in the
// same tx, then preLending (ATAs, obligation init), then the lending ix
// itself, then postLending (wsol unwrap if applicable). pythIxGroups is
// intentionally NOT included — those are batched groups for the multi-tx
// pullPriceTxns flow which we don't use; the inline oracleIxs alone are
// what fits in our single-tx flow.
function flatten(groups: InstructionWithSigners[][]): {
  ixs: TransactionInstruction[];
  signers: Keypair[];
} {
  const ixs: TransactionInstruction[] = [];
  const signers: Keypair[] = [];
  for (const group of groups) {
    for (const w of group) {
      ixs.push(w.instruction);
      if (w.signers && w.signers.length > 0) {
        // The SDK types these as Signer[]; in practice they are Keypair
        // instances (NodeWallet et al). Runtime-asserting before passing
        // along avoids a confusing tx.sign() error later.
        for (const s of w.signers) {
          if (!(s instanceof Keypair)) {
            throw new Error(
              `Save SDK returned a non-Keypair Signer (${s.publicKey?.toBase58?.()}); multi-signer plumbing currently assumes Keypair instances`,
            );
          }
          signers.push(s);
        }
      }
    }
  }
  return { ixs, signers };
}

// Builds the full deposit instruction set for a USDC supply into Save Main
// Pool. Mirror of Kamino's deposit builder, adapted to Save's SDK shape:
//
// - `SaveWallet` is read-only ({ publicKey } only) — no keypair leaves the
//   signer.
// - `getInstructions()` returns categorized ix lists; we concatenate
//   oracleIxs + preLendingIxs + lendingIxs + postLendingIxs.
// - Per-ix ephemeral signers (Pyth pull-oracle keypairs, etc.) are
//   surfaced via BuiltInstructions.extraSigners and added by signSubmit.
//
// Oracle-thin window: if Save's prices need refresh and inline oracleIxs
// aren't enough, simulation fails with a price-staleness error. We surface
// it as ExecuteResult.failure; the user re-proposes (in practice the
// USDC oracle is refreshed continuously by other users).
export async function buildSaveDepositInstructions(
  action: DepositAction,
  ctx: ProtocolCtx,
): Promise<BuiltInstructions> {
  const connection = withFinalizedSlot(ctx.connection);
  const wallet: SaveWallet = { publicKey: ctx.owner };
  const baseUnits = toBaseUnits(action.amountUsdc);

  const core = await SolendActionCore.buildDepositTxns(
    SAVE_MAIN_POOL,
    SAVE_USDC_RESERVE,
    connection,
    baseUnits.toString(),
    wallet,
    {
      environment: 'production',
    },
  );

  const grouped = await core.getInstructions();
  const { ixs, signers } = flatten([
    grouped.oracleIxs,
    grouped.preLendingIxs,
    grouped.lendingIxs,
    grouped.postLendingIxs,
  ]);
  return { instructions: ixs, extraSigners: signers };
}

// Mirror of buildSaveDepositInstructions for withdraws from the same
// reserve. Requires the owner to have an existing obligation (created by
// a prior deposit); if not, SolendActionCore.buildWithdrawTxns errors and
// the signer surfaces it as ExecuteResult.failure.
//
// TODO: phase-2 reads will introduce a "max withdraw" flow. Save's
// max-withdraw sentinel is U64_MAX (= "18446744073709551615"); pass that
// as the `amount` arg to drain the position. Not exposed in WithdrawAction
// yet — defer until we can read positions.
export async function buildSaveWithdrawInstructions(
  action: WithdrawAction,
  ctx: ProtocolCtx,
): Promise<BuiltInstructions> {
  const connection = withFinalizedSlot(ctx.connection);
  const wallet: SaveWallet = { publicKey: ctx.owner };
  const baseUnits = toBaseUnits(action.amountUsdc);

  const core = await SolendActionCore.buildWithdrawTxns(
    SAVE_MAIN_POOL,
    SAVE_USDC_RESERVE,
    connection,
    baseUnits.toString(),
    wallet,
    {
      environment: 'production',
    },
  );

  const grouped = await core.getInstructions();
  const { ixs, signers } = flatten([
    grouped.oracleIxs,
    grouped.preLendingIxs,
    grouped.lendingIxs,
    grouped.postLendingIxs,
  ]);
  return { instructions: ixs, extraSigners: signers };
}

// Format a base-unit Decimal into a decimal-USDC string with up to 6 fraction
// digits, trailing zeros trimmed. Mirrors ProposedAction.amountUsdc shape.
function formatUsdcAmount(baseUnits: Decimal): string {
  if (baseUnits.lte(0)) return '0';
  const usdc = baseUnits.div(new Decimal(10).pow(USDC_DECIMALS));
  return usdc.toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
}

// Fetch the current supply APY for the USDC reserve in Save Main Pool as a
// fractional decimal (0.0523 = 5.23%). Same shape as Kamino's APY return so
// the chat tool can render them side-by-side. One RPC roundtrip
// (fetchPoolByAddress despite the name fetches a single reserve account).
export async function getSaveUsdcSupplyApy(
  connection: Connection,
): Promise<{ apyDecimal: number }> {
  const reserve = await fetchPoolByAddress(SAVE_USDC_RESERVE.address, connection);
  if (!reserve) {
    throw new Error(`Save USDC reserve ${SAVE_USDC_RESERVE.address} did not load`);
  }
  // calculateSupplyInterest with showApy=true returns APY as a fractional
  // BigNumber (utilization × borrowAPR × (1 - protocolTake) compounded by
  // SLOTS_PER_YEAR). Mirrors Kamino's totalSupplyAPY units.
  const apy = calculateSupplyInterest(reserve.info, true);
  return { apyDecimal: apy.toNumber() };
}

// Fetch how much USDC `owner` has supplied into Save Main Pool's USDC reserve.
// Returns '0' if the owner has no obligation yet. Decimal-USDC string with
// 6-digit precision, trailing zeros trimmed — matches ProposedAction.amountUsdc.
//
// Save deposits are stored as cTokens; the human-USDC amount needs the
// reserve's exchange rate. Computed manually from raw reserve fields rather
// than going through formatReserve/formatObligation (those carry a heavy
// price + metadata path we don't need).
export async function getSaveUsdcPosition(
  connection: Connection,
  owner: PublicKey,
): Promise<{ amountUsdc: string }> {
  const [reserve, obligations] = await Promise.all([
    fetchPoolByAddress(SAVE_USDC_RESERVE.address, connection),
    fetchObligationsOfPoolByWallet(
      owner,
      MAIN_POOL_ADDRESS,
      SOLEND_PRODUCTION_PROGRAM_ID,
      connection,
    ),
  ]);
  if (!reserve) {
    throw new Error(`Save USDC reserve ${SAVE_USDC_RESERVE.address} did not load`);
  }
  if (obligations.length === 0) {
    return { amountUsdc: '0' };
  }

  // Sum collateral across any obligations the wallet has in Main Pool.
  // In practice there's one; SDK API returns an array for generality.
  let totalCTokens = new Decimal(0);
  const usdcReserveBase58 = SAVE_USDC_RESERVE.address;
  for (const ob of obligations) {
    for (const dep of ob.info.deposits) {
      if (dep.depositReserve.toBase58() === usdcReserveBase58) {
        totalCTokens = totalCTokens.plus(new Decimal(dep.depositedAmount.toString()));
      }
    }
  }
  if (totalCTokens.lte(0)) {
    return { amountUsdc: '0' };
  }

  // cToken → underlying USDC, base units throughout. Mirrors formatReserve's
  // exchange rate calc: totalSupply = available + borrowed - protocolFees,
  // exchangeRate = totalSupply / cTokenMintTotalSupply.
  const WAD = new Decimal(10).pow(18);
  const availableAmount = new Decimal(reserve.info.liquidity.availableAmount.toString());
  const borrowedAmount = new Decimal(reserve.info.liquidity.borrowedAmountWads.toString()).div(WAD);
  const protocolFees = new Decimal(
    reserve.info.liquidity.accumulatedProtocolFeesWads.toString(),
  ).div(WAD);
  const totalSupplyBaseUnits = availableAmount.plus(borrowedAmount).minus(protocolFees);
  const cTokenMintSupply = new Decimal(reserve.info.collateral.mintTotalSupply.toString());
  if (cTokenMintSupply.lte(0)) {
    // Pre-launch reserve with no liquidity; treat as 0 to avoid div-by-zero.
    return { amountUsdc: '0' };
  }
  const usdcBaseUnits = totalCTokens.mul(totalSupplyBaseUnits).div(cTokenMintSupply);
  return { amountUsdc: formatUsdcAmount(usdcBaseUnits) };
}
