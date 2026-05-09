import {
  type Commitment,
  type Connection,
  type Keypair,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { ExecuteResult } from '@tc/types';
import bs58 from 'bs58';
import type { TreasurySigner } from './types';

export interface SignSubmitConfirmOpts {
  connection: Connection;
  treasurySigner: TreasurySigner;
  instructions: TransactionInstruction[];
  // Ephemeral signers required by individual instructions (e.g. Pyth pull-
  // oracle keypairs from Save's setup ixs, fresh-account keypairs that some
  // protocols require for first-deposit init). Applied via tx.partialSign
  // BEFORE the treasury signs the message; the treasury (fee-payer)
  // signature is then attached at index 0 via tx.addSignature, so
  // signatures[0] remains the fee-payer signature and onSignature/recovery
  // semantics are unchanged. partialSign(...[]) is a no-op, so the empty
  // case (deposit/withdraw on Kamino, etc.) goes through this path too.
  extraSigners?: Keypair[];
  commitment: Commitment;
  timeoutMs: number;
  // Called after signing but before sendRawTransaction. Use this to durably
  // persist the signature so a crash between persist and confirmation can be
  // recovered (re-confirm rather than re-submit). If the hook throws, the tx
  // is NOT broadcast — better to leave an `executing` row with no signature
  // (recovery marks failed) than to broadcast a tx whose signature isn't
  // durably traceable.
  onSignature?: (signature: string) => Promise<void>;
}

// Once the tx has hit the wire, we cannot terminally fail just because our
// confirmation path threw or timed out — the cluster might still land it.
// Ask for the cluster's view; if it knows the tx reverted, fail; if it
// knows the tx confirmed at our requested commitment, succeed; otherwise
// stay pending so the executor leaves the row in `executing` for boot
// recovery to finish.
async function resolvePostBroadcastOutcome(
  connection: Connection,
  signature: string,
  commitment: Commitment,
  reason: string,
): Promise<ExecuteResult> {
  const final = await connection
    .getSignatureStatuses([signature], { searchTransactionHistory: true })
    .then((r) => r.value[0])
    .catch(() => null);
  if (final?.err) {
    return { kind: 'failure', error: `tx reverted: ${JSON.stringify(final.err)}` };
  }
  const status = final?.confirmationStatus;
  if (
    status === 'confirmed' ||
    status === 'finalized' ||
    (status === 'processed' && commitment === 'processed')
  ) {
    return { kind: 'success', txSignature: signature };
  }
  return { kind: 'pending', txSignature: signature, reason };
}

// Builds a legacy Transaction, signs it via the TreasurySigner (the local
// keypair backend signs in-process; Turnkey signs over an HSM API call),
// persists the signature via onSignature, submits, and races confirmation
// against a hard timeout. confirmTransaction hangs indefinitely on a stalled
// RPC; without the race a worker could sit on a `pending` row forever.
//
// Multi-signer ordering matters: ephemeral keypairs (Pyth oracle pulls,
// fresh-account init keys, etc.) sign FIRST via tx.partialSign so their
// public keys are recorded in the message. We then serialize that message
// and ask the TreasurySigner to sign it, attaching the result at the
// fee-payer slot via tx.addSignature. signatures[0] remains the fee-payer
// signature, so the onSignature hook and recovery loop are unchanged.
export async function signSubmitConfirm(opts: SignSubmitConfirmOpts): Promise<ExecuteResult> {
  const {
    connection,
    treasurySigner,
    instructions,
    extraSigners,
    commitment,
    timeoutMs,
    onSignature,
  } = opts;

  let timeoutHandle: NodeJS.Timeout | undefined;
  // Tracks whether sendRawTransaction returned successfully. The catch below
  // must distinguish pre-broadcast errors (terminal failure — nothing on the
  // wire) from post-broadcast errors (uncertain — could still land).
  let broadcastedSignature: string | undefined;
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
    const tx = new Transaction({
      blockhash,
      lastValidBlockHeight,
      feePayer: treasurySigner.publicKey,
    });
    tx.add(...instructions);

    // Order: ephemeral signers first (no-op when empty), then the treasury.
    // Calling partialSign with an empty list is safe — common single-signer
    // path (Kamino deposit/withdraw) hits exactly this branch.
    if (extraSigners && extraSigners.length > 0) {
      tx.partialSign(...extraSigners);
    }

    // Bracket the treasury sign call so the slow-Turnkey case is visible in
    // logs without grepping. Local backend logs ~ms; Turnkey logs hundreds.
    const signStart = Date.now();
    const message = tx.serializeMessage();
    const treasurySigBytes = await treasurySigner.signSerializedMessage(message);
    const signMs = Date.now() - signStart;
    console.log(`[signer] treasury sign ${signMs}ms`);
    tx.addSignature(treasurySigner.publicKey, Buffer.from(treasurySigBytes));

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
    broadcastedSignature = signature;

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
      return resolvePostBroadcastOutcome(
        connection,
        signature,
        commitment,
        'confirmation timeout; cluster status unsettled',
      );
    }

    if (raced.value.err) {
      return {
        kind: 'failure',
        error: `tx reverted: ${JSON.stringify(raced.value.err)}`,
      };
    }
    return { kind: 'success', txSignature: signature };
  } catch (err) {
    // If the tx already hit the wire, an RPC/transport error here doesn't
    // mean the tx failed — only that our view of it failed. Resolve via
    // cluster status; if still unsettled, return pending so recovery can
    // finish it. Errors before broadcast remain terminal.
    if (broadcastedSignature) {
      const reason = `post-broadcast error: ${err instanceof Error ? err.message : String(err)}`;
      return resolvePostBroadcastOutcome(
        opts.connection,
        broadcastedSignature,
        opts.commitment,
        reason,
      );
    }
    return { kind: 'failure', error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
