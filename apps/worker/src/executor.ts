import {
  IllegalTransitionError,
  TransitionConflictError,
  findApprovedForExecution,
  findInFlightExecutions,
  getApprovalAttribution,
  setActionIntermediateSignature,
  setActionTxSignature,
  transitionAction,
} from '@tc/db';
import { type PolicyDecision, deriveRebalanceLegs } from '@tc/policy';
import { createSigner } from '@tc/signer';
import type { ExecuteResult, ProposedAction } from '@tc/types';
import { editApprovalCardWithExecution } from './bot';

type AllowDecision = Extract<PolicyDecision, { kind: 'allow' }>;

// editApprovalCardWithExecution can fail (>48h message, network blip). DB is
// the source of truth; failing the card is cosmetic, not a recovery error.
async function safeEditCard(
  row: Awaited<ReturnType<typeof transitionAction>>,
  result: Extract<ExecuteResult, { kind: 'success' | 'failure' }>,
): Promise<void> {
  try {
    const attribution = await getApprovalAttribution(db, row.id);
    await editApprovalCardWithExecution(row, result, attribution);
  } catch (editErr) {
    console.error(`[executor] failed to edit Telegram card for ${row.id}:`, editErr);
  }
}
import { db } from './db';
import { env } from './env';

const signer = createSigner({
  rpcUrl: env.SOLANA_RPC_URL,
  keypairPath: env.SOLANA_KEYPAIR_PATH,
  commitment: env.SIGNER_COMMITMENT,
  confirmTimeoutMs: env.SIGNER_CONFIRM_TIMEOUT_MS,
});

// Persist the leg-2 (deposit / single-leg) signature into `tx_signature`.
// Throws if the CAS-on-NULL loses, telling the signer to abort before
// broadcast — same shape as the original onSignature in tick().
async function persistFinalSignature(actionId: string, sig: string): Promise<void> {
  const won = await setActionTxSignature(db, actionId, sig);
  if (!won) throw new Error(`signature persistence lost the race for ${actionId}`);
}

// Persist the leg-1 (withdraw) signature for a rebalance into
// `rebalance_intermediate_signature`. Same CAS-on-NULL shape.
async function persistIntermediateSignature(actionId: string, sig: string): Promise<void> {
  const won = await setActionIntermediateSignature(db, actionId, sig);
  if (!won) throw new Error(`intermediate signature persistence lost the race for ${actionId}`);
}

// Run a rebalance from leg-1 (withdraw) through leg-2 (deposit). Returns the
// terminal ExecuteResult — either leg-1's failure/pending if it didn't reach
// success, or leg-2's success/failure/pending. The caller transitions the
// row to executed/failed based on this result, identical to the single-leg
// path. `actionId` is used only for log lines.
async function driveRebalanceFromStart(
  actionId: string,
  decision: AllowDecision,
): Promise<ExecuteResult> {
  const { withdraw } = deriveRebalanceLegs(decision);

  console.log(`[executor] action ${actionId} rebalance leg-1 (withdraw) starting`);
  const leg1 = await signer.executeApproved(withdraw, {
    onSignature: (sig) => persistIntermediateSignature(actionId, sig),
  });
  if (leg1.kind !== 'success') {
    // failure or pending — stop here. Pending leaves the row in `executing`
    // for boot recovery to finish; failure terminally fails the row.
    return leg1;
  }
  console.log(
    `[executor] action ${actionId} rebalance leg-1 confirmed ${leg1.txSignature}, executing leg-2 (deposit)`,
  );
  return driveRebalanceLeg2(actionId, decision);
}

// Run only leg-2 (deposit). Used both as the second half of
// driveRebalanceFromStart and from boot recovery when leg-1 already
// confirmed in a prior run but leg-2 never started.
async function driveRebalanceLeg2(
  actionId: string,
  decision: AllowDecision,
): Promise<ExecuteResult> {
  const { deposit } = deriveRebalanceLegs(decision);
  const leg2 = await signer.executeApproved(deposit, {
    onSignature: (sig) => persistFinalSignature(actionId, sig),
  });
  if (leg2.kind === 'failure') {
    // Leg-1 already moved funds to the wallet ATA. Annotate the error so the
    // user / operator knows the funds are not lost — they sit in the wallet
    // and can be re-deposited manually.
    return {
      kind: 'failure',
      error: `${leg2.error} (leg-1 funds remain in wallet; can be re-deposited manually)`,
    };
  }
  return leg2;
}

// Drive the signer for an `allow` decision. For rebalance, walks both legs;
// for single-leg actions, behaves exactly as the original tick() did.
async function executeDecision(
  actionId: string,
  decision: AllowDecision,
  payload: ProposedAction,
): Promise<ExecuteResult> {
  if (payload.kind === 'rebalance') {
    return driveRebalanceFromStart(actionId, decision);
  }
  return signer.executeApproved(decision, {
    onSignature: (sig) => persistFinalSignature(actionId, sig),
  });
}

let timer: NodeJS.Timeout | null = null;
let starting = false;
// Stop requested between startExecutor() and the .finally() that arms the
// interval. The bootstrap path checks this and skips arming so a shutdown
// signal during boot is honored.
let stopRequestedDuringStart = false;
let inFlight = false;

// One tick: find approved rows, claim each atomically (approved → executing),
// run the signer, transition to executed/failed (or leave executing on
// `pending`), edit the Telegram card. Mirrors the structure of poller.ts
// (re-entrancy guard, per-action try/catch so one bad row doesn't kill the
// loop). Per-action errors stay logged; outer catch handles DB failures.
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const approved = await findApprovedForExecution(db);
    for (const row of approved) {
      // Tracks whether we successfully flipped this row to `executing`. Used
      // in the outer catch to decide whether to drive an orphaned row to a
      // terminal state (only safe if we know the row is `executing`, not
      // still `approved` — an unclaimed row can be retried next tick).
      let claimedForExecution = false;
      // Hoisted so the outer catch can branch on it: a successful signer
      // result whose post-success bookkeeping crashes must not be downgraded
      // to `failed` — the tx is already on-chain.
      let result: ExecuteResult | undefined;
      try {
        // Atomic claim: only one replica wins the approved → executing flip.
        // Without this, two workers could both call the signer for the same
        // row before either's terminal transition lands — meaning two on-chain
        // submissions for one approval. A conflict here means a peer claimed
        // it (or status changed under us); skip and let them run it.
        let claimed: Awaited<ReturnType<typeof transitionAction>>;
        try {
          claimed = await transitionAction(db, {
            id: row.id,
            from: 'approved',
            to: 'executing',
            actor: 'signer',
          });
        } catch (claimErr) {
          if (claimErr instanceof TransitionConflictError) continue;
          throw claimErr;
        }
        claimedForExecution = true;
        console.log(`[executor] action ${row.id} claimed, submitting`);

        // Authorization came from either a policy `allow` decision (auto-
        // approval at insert time) or a Telegram allowlisted approver
        // (recorded in `approvals` + `transitionAction(pending→approved)`).
        // Either way, `row.payload` is the canonical action; `policyDecision`
        // records the *original* verdict and stays at `requires_approval` for
        // human-approved rows by design (audit history). So we construct the
        // `allow`-shaped decision here from `payload` to satisfy the Signer's
        // type contract.
        const decision: AllowDecision = { kind: 'allow', action: claimed.payload };
        result = await executeDecision(row.id, decision, claimed.payload);

        if (result.kind === 'pending') {
          // Tx broadcast but cluster status unsettled; do NOT terminally
          // transition. Leave the row in `executing` for the next boot's
          // recovery sweep to finish. Force-failing here would risk a
          // double-execute if the tx eventually lands.
          console.warn(
            `[executor] action ${row.id} pending: ${result.reason} ${result.txSignature}`,
          );
          continue;
        }

        if (result.kind === 'success') {
          console.log(`[executor] action ${row.id} executed ${result.txSignature}`);
        } else {
          console.warn(`[executor] action ${row.id} failed: ${result.error}`);
        }

        const updated = await transitionAction(db, {
          id: row.id,
          from: 'executing',
          to: result.kind === 'success' ? 'executed' : 'failed',
          actor: 'signer',
          payload:
            result.kind === 'success'
              ? { txSignature: result.txSignature }
              : { error: result.error },
        });

        const attribution = await getApprovalAttribution(db, row.id);
        try {
          await editApprovalCardWithExecution(updated, result, attribution);
        } catch (editErr) {
          // DB is the source of truth; failing to update the Telegram card is
          // cosmetic. Common causes: message > 48h old, network blip.
          console.error(`[executor] failed to edit Telegram card for ${row.id}:`, editErr);
        }
      } catch (err) {
        console.error(`[executor] failed to execute action ${row.id}:`, err);
        if (!claimedForExecution) continue;

        if (result?.kind === 'success') {
          // Signer succeeded on-chain; only the bookkeeping write failed.
          // Retrying the executed-transition is the only correct move —
          // flipping to `failed` here would lie about a confirmed tx. If
          // the retry also fails, leave the row in `executing` and let
          // boot recovery's signature lookup finish it.
          try {
            await transitionAction(db, {
              id: row.id,
              from: 'executing',
              to: 'executed',
              actor: 'signer',
              payload: { txSignature: result.txSignature },
            });
          } catch (retryErr) {
            if (!(retryErr instanceof TransitionConflictError)) {
              console.error(
                `[executor] action ${row.id} succeeded on-chain (${result.txSignature}) but bookkeeping retry failed:`,
                retryErr,
              );
            }
          }
        } else {
          // No success result — drive to failed. If the final transitionAction
          // actually landed before we threw, the CAS rejects this with
          // TransitionConflictError; swallow that.
          try {
            const message = err instanceof Error ? err.message : String(err);
            await transitionAction(db, {
              id: row.id,
              from: 'executing',
              to: 'failed',
              actor: 'signer',
              payload: { error: message },
            });
          } catch (markErr) {
            if (!(markErr instanceof TransitionConflictError)) {
              console.error(`[executor] failed to mark ${row.id} as failed:`, markErr);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[executor] tick failed:', err);
  } finally {
    inFlight = false;
  }
}

// Resolve any rows left in `executing` by a previous worker process.
// Two sub-cases:
// - tx_signature populated: signer signed and persisted, but the worker
//   crashed before observing confirmation. Re-confirm via signature lookup
//   (no re-submit). Move to executed/failed only on a definitive cluster
//   answer; rows whose status is `processed` or unknown stay in `executing`
//   for the next boot's sweep — terminal-failing them risks a double-execute
//   if the tx is still landing.
// - tx_signature NULL: worker crashed between claim and sign. Conservative
//   path: mark failed; user re-proposes. Backward `executing → approved`
//   would also work but isn't in LEGAL_TRANSITIONS by design.
//
// Single-process assumption: this scans every row in `executing`, including
// rows a peer worker is currently mid-execution on. Treasury Copilot runs
// single-replica today (Telegram bot needs a long-lived process; horizontal
// scale-out would require a leader election anyway). If multi-replica is
// ever added, gate this on a staleness threshold (e.g., ignore rows touched
// in the last 60s) so a rebooting worker doesn't race a live one.
async function recoverInFlight(): Promise<void> {
  const stuck = await findInFlightExecutions(db);
  if (stuck.length === 0) return;
  console.log(`[executor] recovering ${stuck.length} in-flight row(s)`);

  for (const row of stuck) {
    try {
      // Rebalance with leg-1 sig set but leg-2 missing: worker crashed
      // between leg-1 confirm and leg-2 broadcast. Look up leg-1 status — if
      // confirmed, drive leg-2 to completion; otherwise treat the
      // intermediate as the canonical "is this tx alive?" signature.
      if (
        row.payload.kind === 'rebalance' &&
        row.rebalanceIntermediateSignature &&
        !row.txSignature
      ) {
        const intermediateSig = row.rebalanceIntermediateSignature;
        const status = await signer.checkSignatureStatus(intermediateSig);
        if (status.kind === 'reverted') {
          const error = `recovery: rebalance leg-1 reverted: ${JSON.stringify(status.err)}`;
          const updated = await transitionAction(db, {
            id: row.id,
            from: 'executing',
            to: 'failed',
            actor: 'signer',
            payload: { error, rebalanceIntermediateSignature: intermediateSig },
          });
          console.warn(
            `[executor] action ${row.id} recovered → failed (leg-1 reverted) ${intermediateSig}`,
          );
          await safeEditCard(updated, { kind: 'failure', error });
          continue;
        }
        if (status.kind === 'pending') {
          console.log(
            `[executor] action ${row.id} leg-1 still pending in recovery; leaving executing ${intermediateSig}`,
          );
          continue;
        }
        // Confirmed: resume leg-2.
        console.log(
          `[executor] action ${row.id} leg-1 confirmed; resuming rebalance leg-2 (deposit)`,
        );
        const decision: AllowDecision = { kind: 'allow', action: row.payload };
        const leg2 = await driveRebalanceLeg2(row.id, decision);
        if (leg2.kind === 'pending') {
          console.warn(
            `[executor] action ${row.id} leg-2 pending in recovery: ${leg2.reason} ${leg2.txSignature}`,
          );
          continue;
        }
        const updated = await transitionAction(db, {
          id: row.id,
          from: 'executing',
          to: leg2.kind === 'success' ? 'executed' : 'failed',
          actor: 'signer',
          payload:
            leg2.kind === 'success'
              ? { txSignature: leg2.txSignature, rebalanceIntermediateSignature: intermediateSig }
              : { error: leg2.error, rebalanceIntermediateSignature: intermediateSig },
        });
        console.log(
          `[executor] action ${row.id} recovered → ${leg2.kind === 'success' ? 'executed' : 'failed'} (leg-2)`,
        );
        await safeEditCard(updated, leg2);
        continue;
      }

      if (!row.txSignature) {
        await transitionAction(db, {
          id: row.id,
          from: 'executing',
          to: 'failed',
          actor: 'signer',
          payload: { error: 'recovery: claimed but never signed' },
        });
        console.warn(`[executor] action ${row.id} recovered → failed (never signed)`);
        continue;
      }

      const sig = row.txSignature;
      const status = await signer.checkSignatureStatus(sig);
      if (status.kind === 'reverted') {
        const error = `recovery: tx reverted: ${JSON.stringify(status.err)}`;
        const updated = await transitionAction(db, {
          id: row.id,
          from: 'executing',
          to: 'failed',
          actor: 'signer',
          payload: { error, txSignature: sig },
        });
        console.warn(`[executor] action ${row.id} recovered → failed (reverted) ${sig}`);
        await safeEditCard(updated, { kind: 'failure', error });
      } else if (status.kind === 'confirmed') {
        const updated = await transitionAction(db, {
          id: row.id,
          from: 'executing',
          to: 'executed',
          actor: 'signer',
          payload: { txSignature: sig },
        });
        console.log(`[executor] action ${row.id} recovered → executed ${sig}`);
        await safeEditCard(updated, { kind: 'success', txSignature: sig });
      } else {
        // pending: cluster knows the tx but hasn't confirmed it, OR the RPC
        // hasn't indexed it yet. Leave in `executing` for the next sweep —
        // marking failed here is the false negative that could cause a
        // double-execute if the tx eventually lands.
        console.log(
          `[executor] action ${row.id} still pending in recovery; leaving executing ${sig}`,
        );
      }
    } catch (err) {
      // A peer may have resolved this row between our select and our update.
      // Swallow that; surface anything else.
      if (err instanceof TransitionConflictError || err instanceof IllegalTransitionError) {
        continue;
      }
      console.error(`[executor] recovery failed for ${row.id}:`, err);
    }
  }
}

function stopExecutor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Bootstrap is still running — flag it so the .finally() doesn't arm an
  // interval we'd then leak. Without this, a stop() during recovery is a
  // no-op against null timer and the interval scheduled in finally() is
  // never cancelled.
  if (starting) {
    stopRequestedDuringStart = true;
  }
}

export function startExecutor(): () => void {
  if (timer || starting) {
    console.log('[executor] already running, ignoring duplicate start');
    return stopExecutor;
  }
  console.log(`[executor] starting (interval=${env.EXECUTOR_POLL_INTERVAL_MS}ms)`);
  starting = true;
  stopRequestedDuringStart = false;
  // Recover first, then start the normal poll loop. If recovery fails, log
  // and continue — a stuck row won't block fresh actions.
  void recoverInFlight()
    .catch((err) => console.error('[executor] recovery loop crashed:', err))
    .finally(() => {
      starting = false;
      if (stopRequestedDuringStart) {
        stopRequestedDuringStart = false;
        return;
      }
      void tick();
      timer = setInterval(() => void tick(), env.EXECUTOR_POLL_INTERVAL_MS);
    });
  return stopExecutor;
}
