import { Connection, PublicKey } from '@solana/web3.js';
import type { TransferAction } from '@tc/types';
import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID_BASE58, buildUsdcTransferInstructions } from './transfer';
import { USDC_MINT_BASE58 } from './usdc';

// These tests don't hit the network — `buildUsdcTransferInstructions`
// constructs ixs from sync helpers + a few program-id derivations. The
// Connection passed in is a placeholder that never gets called.
const dummyConnection = new Connection('http://localhost:1');

// On-curve test fixtures. Owner MUST be on-curve (Ed25519 keypair-derived);
// the builder rejects off-curve owners because a treasury wallet is always a
// real keypair. Recipient is allowed off-curve (PDAs are valid recipients);
// these were picked from Keypair.generate() output and are independently
// verified on-curve via PublicKey.isOnCurve.
const OWNER = 'JDfx1M11Q53sgG86UTpnSChGgrmoQFPH3vkKMEfF5s84';
const RECIPIENT = 'EJN2QEouXLUBuo8u4Gm4VG56H48FGa7ZSsZtpE3VevNf';
const TREASURY_ID = '00000000-0000-4000-8000-000000000001';

function makeAction(overrides: Partial<TransferAction> = {}): TransferAction {
  return {
    kind: 'transfer',
    treasuryId: TREASURY_ID,
    sourceWallet: OWNER,
    recipientAddress: RECIPIENT,
    tokenMint: USDC_MINT_BASE58,
    amountUsdc: '100',
    ...overrides,
  };
}

const ctx = (owner = OWNER) => ({
  connection: dummyConnection,
  owner: new PublicKey(owner),
});

// Program ids used in assertions. Hardcoded so the test pins the actual
// values it expects — if a dep upgrade swapped a program id, the test
// catches it (which is the whole point of an allowlist-style guard).
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('buildUsdcTransferInstructions', () => {
  it('emits the expected ix sequence for a basic transfer (no memo)', async () => {
    const { instructions, extraSigners } = await buildUsdcTransferInstructions(makeAction(), ctx());

    expect(extraSigners).toEqual([]);
    expect(instructions).toHaveLength(4);

    const pids = instructions.map((ix) => ix.programId.toBase58());
    // setComputeUnitLimit (index 0), setComputeUnitPrice (index 1), ATA-create (index 2), transferChecked (index 3).
    expect(pids).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, ATA_PROGRAM, SPL_TOKEN]);
  });

  it('appends a memo ix when memo is set', async () => {
    const { instructions } = await buildUsdcTransferInstructions(
      makeAction({ memo: 'Q1 payroll' }),
      ctx(),
    );

    expect(instructions).toHaveLength(5);
    const memo = instructions[4];
    expect(memo?.programId.toBase58()).toBe(MEMO_PROGRAM_ID_BASE58);
    expect(memo?.keys).toEqual([]);
    // utf-8 bytes round-trip via the Buffer constructor.
    expect(memo?.data.toString('utf8')).toBe('Q1 payroll');
  });

  it('rejects non-USDC mints (forward-compat carve-out)', async () => {
    // tokenMint field is forward-compatible at the type level, but the
    // signer + this builder reject non-USDC today.
    const action = makeAction({ tokenMint: 'So11111111111111111111111111111111111111112' });
    await expect(buildUsdcTransferInstructions(action, ctx())).rejects.toThrow(/USDC/);
  });

  it('rejects an empty memo string from being emitted as a no-op ix', async () => {
    // Defensive: an explicit empty memo should not produce a 5th ix. The
    // optional-field semantics in the action type ("undefined OR present")
    // mean callers might pass `''` from a form input.
    const { instructions } = await buildUsdcTransferInstructions(makeAction({ memo: '' }), ctx());
    expect(instructions).toHaveLength(4);
  });

  it('encodes the amount as base units using mint decimals (6)', async () => {
    // 100 USDC = 100_000_000 base units. The transferChecked ix encodes
    // the amount as a little-endian u64 at offset 1 of its data buffer
    // (offset 0 is the discriminator). Decoding just enough to verify.
    const { instructions } = await buildUsdcTransferInstructions(
      makeAction({ amountUsdc: '100' }),
      ctx(),
    );
    const transferIx = instructions[3];
    expect(transferIx?.programId.toBase58()).toBe(SPL_TOKEN);
    // SPL token instructions encode the amount as the next 8 bytes after
    // the 1-byte discriminator.
    const amountLE = transferIx?.data.subarray(1, 9);
    const amount = amountLE?.readBigUInt64LE(0);
    expect(amount).toBe(100_000_000n);
  });

  it('encodes fractional amounts correctly (6-decimal precision)', async () => {
    const { instructions } = await buildUsdcTransferInstructions(
      makeAction({ amountUsdc: '0.123456' }),
      ctx(),
    );
    const transferIx = instructions[3];
    const amountLE = transferIx?.data.subarray(1, 9);
    expect(amountLE?.readBigUInt64LE(0)).toBe(123_456n);
  });
});
