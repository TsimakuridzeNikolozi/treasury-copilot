import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { TransferAction } from '@tc/types';
import Decimal from 'decimal.js';
import type { BuiltInstructions, ProtocolCtx } from './types';
import { USDC_MINT_BASE58 } from './usdc';

// Hand-rolled token-transfer primitives. We deliberately do NOT depend on
// `@solana/spl-token` here even though the package exposes the same helpers
// — the workspace also pulls in a much older 0.1.8 version transitively
// (via whirlpool-sdk inside solend-sdk's types), and the duplicate package
// names confuse TypeScript's module resolution so it surfaces 0.1.8's API
// even when a direct dep pins 0.4.14. Hand-rolling the three ixs we need
// keeps the dep graph clean, the program-id allowlist auditable, and
// removes a ~hundred-KB transitive dep — at the cost of ~40 lines we'd
// otherwise hide inside an SDK helper.

// Mainnet program ids. Pinned constants so the signer's TRANSFER_ALLOWED_PROGRAMS
// set can reference them without importing from this builder.
export const TOKEN_PROGRAM_ID_BASE58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID_BASE58 = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM_ID_BASE58 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM_ID_BASE58);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID_BASE58);
const MEMO_PROGRAM_ID = new PublicKey(MEMO_PROGRAM_ID_BASE58);

// USDC has 6 decimals. transferChecked requires the decimals match the
// mint — passing the wrong value fails on-chain. Hard-coded because this
// module is USDC-only today; multi-asset support is M4-future and would
// read decimals from the mint account.
const USDC_DECIMALS = 6;

// Priority fee in micro-lamports per compute unit. Matches the Kamino /
// Save SDKs' default "moderate" tier — enough to land during normal
// congestion, not aggressive enough to overpay during quiet periods.
// Fixed for now; future PR can read live priority-fee samples from the RPC.
const PRIORITY_FEE_MICROLAMPORTS_PER_CU = 100_000;

// ATA discriminator: byte 1 selects the idempotent variant (byte 0 is the
// classic Create which errors when the ATA already exists). Stable since
// 2022 — same as the @solana/spl-token helper emits.
const ATA_IDEMPOTENT_DISCRIMINATOR = 1;
// SPL Token program TransferChecked variant — instruction byte 12 in the
// program's instruction enum. Stable since the program's initial release.
const TOKEN_TRANSFER_CHECKED_DISCRIMINATOR = 12;

// PDA derivation for an Associated Token Account. Deterministic, no RPC:
//   seeds = [owner, TOKEN_PROGRAM_ID, mint], programId = ASSOCIATED_TOKEN_PROGRAM_ID.
// Matches @solana/spl-token's getAssociatedTokenAddressSync exactly.
// `allowOwnerOffCurve` lets PDAs receive too — needed because not every
// recipient address is on the Ed25519 curve, and forbidding it would
// reject valid program-owned addresses.
function deriveAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error('owner is off-curve and allowOwnerOffCurve is false');
  }
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// Build the idempotent ATA-create ix. ATA program v1 layout:
//   accounts: [payer (signer, writable), ata (writable), owner, mint,
//              SystemProgram, TOKEN_PROGRAM_ID]
//   data:     [discriminator] (1 byte)
function buildCreateAtaIdempotentInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([ATA_IDEMPOTENT_DISCRIMINATOR]),
  };
}

// Build the TransferChecked ix. SPL Token program layout:
//   accounts: [source (writable), mint, dest (writable), owner (signer)]
//   data:     [discriminator(1)] [amount u64-LE(8)] [decimals(1)]
// The "Checked" variant verifies mint + decimals on-chain — catches a
// stale or compromised token account where the mint somehow differs.
// Same fee as plain Transfer.
function buildTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(TOKEN_TRANSFER_CHECKED_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

// Convert a decimal USDC string ("123.456789") to a base-units BigInt
// (123456789n). The amountUsdc regex in @tc/types caps fraction digits at 6,
// so this multiplication never loses precision; the integer-part is
// unbounded, so we use BigInt (not Number) end-to-end.
function toBaseUnits(amountUsdc: string): bigint {
  // Decimal.js for the parse step (preserves arbitrary precision), then
  // toFixed(0) to materialise the base-unit integer string. Going through
  // Number would lose precision past 2^53; going through string-split
  // would replicate logic that decimal.js already does correctly.
  return BigInt(new Decimal(amountUsdc).mul(10 ** USDC_DECIMALS).toFixed(0));
}

// M4 PR 1 — build the instructions for an approved USDC transfer.
//
// Pipeline:
//   1. Priority fee (ComputeBudget setComputeUnitPrice). Mirrors the
//      Kamino/Save/Jupiter SDKs' implicit priority-fee behavior; emitted
//      explicitly here because this builder is hand-rolled.
//   2. Recipient ATA setup (idempotent variant of the ATA-create ix).
//      Idempotent — if the ATA already exists, the program no-ops. Cheap
//      to always include; saves us a getAccountInfo RPC round-trip and a
//      conditional branch.
//   3. transferChecked from source ATA to recipient ATA. The "Checked"
//      variant verifies the mint + decimals on-chain, catching a stale or
//      compromised token account where mint somehow differs. Same fee.
//   4. Optional memo. Plain SPL Memo v2 ix: no keys, data = utf-8 bytes
//      of `action.memo`.
//
// USDC-only today. The builder throws on any other mint; the signer's
// executeApproved catches the rejection.
// `extraSigners` is always empty — the treasury wallet is the sole signer
// (added by the signer as fee-payer, signatures[0]).
//
// `connection` is in the context for symmetry with other builders but not
// used today: idempotent ATA-create + transferChecked don't need to read
// chain state to construct the ix list. A future variant that pre-checks
// ATA existence to skip the create ix would use it.
export async function buildUsdcTransferInstructions(
  action: TransferAction,
  ctx: ProtocolCtx,
): Promise<BuiltInstructions> {
  if (action.tokenMint !== USDC_MINT_BASE58) {
    throw new Error(
      `buildUsdcTransferInstructions only supports USDC mint; got ${action.tokenMint}`,
    );
  }

  const owner = ctx.owner;
  const mint = new PublicKey(action.tokenMint);
  const recipient = new PublicKey(action.recipientAddress);
  const amount = toBaseUnits(action.amountUsdc);

  // ATAs derive deterministically (no RPC needed). Recipient may be a PDA
  // (allowOwnerOffCurve=true) — common for program-owned vaults.
  const sourceAta = deriveAssociatedTokenAddress(mint, owner);
  const recipientAta = deriveAssociatedTokenAddress(mint, recipient, /* allowOwnerOffCurve */ true);

  const instructions: TransactionInstruction[] = [
    // Priority fee.
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICROLAMPORTS_PER_CU,
    }),
    // Idempotent recipient-ATA create. Payer = owner (treasury wallet).
    buildCreateAtaIdempotentInstruction(owner /* payer */, recipientAta, recipient, mint),
    // The actual transfer. transferChecked verifies mint + decimals on-chain.
    buildTransferCheckedInstruction(sourceAta, mint, recipientAta, owner, amount, USDC_DECIMALS),
  ];

  if (action.memo !== undefined && action.memo.length > 0) {
    // Memo v2: no keys, data = utf-8 bytes. The on-chain program emits
    // the bytes verbatim in tx logs — no escaping required by the program,
    // though Telegram / log viewers may render UTF-8 with their own rules.
    instructions.push({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(action.memo, 'utf8'),
    });
  }

  return { instructions, extraSigners: [] };
}
