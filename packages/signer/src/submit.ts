import {
  type Commitment,
  type Connection,
  type Keypair,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { ExecuteResult } from '@tc/types';
import bs58 from 'bs58';

export interface SignSubmitConfirmOpts {
  connection: Connection;
  keypair: Keypair;
  instructions: TransactionInstruction[];
  commitment: Commitment;
  timeoutMs: number;
  // Called after tx.sign() but before sendRawTransaction(). Use this to
  // durably persist the signature so a crash between persist and confirmation
  // can be recovered (re-confirm the signature rather than re-submit). If the
  // hook throws, the tx is NOT broadcast — better to leave an `executing` row
  // with no signature (recovery marks failed) than to broadcast a tx whose
  // signature isn't durably traceable.
  onSignature?: (signature: string) => Promise<void>;
}

// Builds a legacy Transaction, signs, persists the signature via onSignature,
// submits, and races confirmation against a hard timeout. confirmTransaction
// hangs indefinitely on a stalled RPC; without the race a worker could sit on
// a `pending` row forever.
//
// Single-signer assumption: tx.sign(keypair) signs only with the fee payer.
// All current dispatch paths (Kamino vanilla deposit, smoke self-transfer)
// satisfy this. If a future protocol path requires extra signers (e.g.,
// initializing an obligation with a fresh keypair instead of a PDA),
// sendRawTransaction will reject loudly — so this isn't silent breakage,
// but the call site will need to switch to partialSign + add the extras.
export async function signSubmitConfirm(opts: SignSubmitConfirmOpts): Promise<ExecuteResult> {
  const { connection, keypair, instructions, commitment, timeoutMs, onSignature } = opts;

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: keypair.publicKey,
    });
    tx.add(...instructions);
    tx.sign(keypair);

    // Solana signatures are deterministic from the signed bytes, so the
    // base58-encoded fee-payer signature here matches what the cluster will
    // index the tx by.
    const sigBytes = tx.signature;
    if (!sigBytes) {
      return { kind: 'failure', error: 'transaction has no signature after sign()' };
    }
    const signature = bs58.encode(sigBytes);

    if (onSignature) {
      try {
        await onSignature(signature);
      } catch (err) {
        return {
          kind: 'failure',
          error: `persist signature failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: commitment,
    });

    const confirmPromise = connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      commitment,
    );
    const TIMEOUT_SENTINEL = Symbol('timeout');
    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });
    const raced = await Promise.race([confirmPromise, timeoutPromise]);

    if (raced === TIMEOUT_SENTINEL) {
      // Confirmation timed out, but the tx was already broadcast and may
      // still land. Do one final status check before giving up — if the
      // cluster knows it confirmed, return success; if reverted, failure;
      // otherwise return pending so the executor leaves the row in
      // `executing` for the next boot's recovery sweep. Force-failing here
      // would risk a double-execute if the tx eventually lands.
      const final = await connection
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .then((r) => r.value[0])
        .catch(() => null);
      if (final?.err) {
        return {
          kind: 'failure',
          error: `tx reverted: ${JSON.stringify(final.err)}`,
        };
      }
      if (final?.confirmationStatus === 'confirmed' || final?.confirmationStatus === 'finalized') {
        return { kind: 'success', txSignature: signature };
      }
      return {
        kind: 'pending',
        txSignature: signature,
        reason: 'confirmation timeout; cluster status unsettled',
      };
    }

    if (raced.value.err) {
      return {
        kind: 'failure',
        error: `tx reverted: ${JSON.stringify(raced.value.err)}`,
      };
    }
    return { kind: 'success', txSignature: signature };
  } catch (err) {
    return { kind: 'failure', error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
