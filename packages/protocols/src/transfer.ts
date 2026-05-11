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

// Hand-rolled token-transfer primitives — deliberately avoids @solana/spl-token
// because the workspace pulls in v0.1.8 transitively (whirlpool-sdk), which
// confuses TypeScript module resolution into surfacing the old API over our v0.4.14.

// Mainnet program ids — exported so TRANSFER_ALLOWED_PROGRAMS can reference them
// without a separate import and the two can't silently diverge.
export const TOKEN_PROGRAM_ID_BASE58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID_BASE58 = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM_ID_BASE58 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM_ID_BASE58);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID_BASE58);
const MEMO_PROGRAM_ID = new PublicKey(MEMO_PROGRAM_ID_BASE58);

// transferChecked requires decimals to match the mint on-chain; hard-coded
// because this module is USDC-only today.
const USDC_DECIMALS = 6;

// Priority fee in micro-lamports per compute unit — "moderate" tier, matches
// Kamino/Save SDKs' implicit default.
const PRIORITY_FEE_MICROLAMPORTS_PER_CU = 100_000;
// Explicit CU ceiling for a transferChecked + idempotent ATA-create.
// Real consumption is ~15–25k; 50k is a comfortable buffer. Without an
// explicit limit the runtime requests the chain default (1.4M CUs), which
// makes the effective fee ceiling ~0.14 SOL — an outlier during congestion.
const TRANSFER_COMPUTE_UNIT_LIMIT = 50_000;

// byte 1 = idempotent create (byte 0 = classic, errors if ATA already exists). Stable since 2022.
const ATA_IDEMPOTENT_DISCRIMINATOR = 1;
// TransferChecked variant — ix byte 12 in the SPL Token enum. Stable since initial release.
const TOKEN_TRANSFER_CHECKED_DISCRIMINATOR = 12;

// seeds = [owner, TOKEN_PROGRAM_ID, mint]. `allowOwnerOffCurve` accepts PDAs as recipients.
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

// "Checked" variant verifies mint + decimals on-chain at no extra fee cost.
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

// Decimal.js avoids float precision loss past 2^53 for large integer parts.
function toBaseUnits(amountUsdc: string): bigint {
  return BigInt(new Decimal(amountUsdc).mul(10 ** USDC_DECIMALS).toFixed(0));
}

// USDC-only; throws on any other mint. `connection` unused today (all derivations
// are deterministic) but present for symmetry with other builders.
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
    // CU limit before price — convention; limit ix must precede price ix.
    ComputeBudgetProgram.setComputeUnitLimit({ units: TRANSFER_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: PRIORITY_FEE_MICROLAMPORTS_PER_CU,
    }),
    // Idempotent recipient-ATA create. Payer = owner (treasury wallet).
    buildCreateAtaIdempotentInstruction(owner /* payer */, recipientAta, recipient, mint),
    // The actual transfer. transferChecked verifies mint + decimals on-chain.
    buildTransferCheckedInstruction(sourceAta, mint, recipientAta, owner, amount, USDC_DECIMALS),
  ];

  if (action.memo !== undefined && action.memo.length > 0) {
    instructions.push({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(action.memo, 'utf8'),
    });
  }

  return { instructions, extraSigners: [] };
}
