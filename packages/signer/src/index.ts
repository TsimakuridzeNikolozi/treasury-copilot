import {
  type Commitment,
  Connection,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  KLEND_PROGRAM_ID_BASE58,
  buildKaminoDepositInstructions,
  buildKaminoWithdrawInstructions,
} from '@tc/protocols/kamino';
import type { ExecuteResult, PolicyDecision } from '@tc/types';
import { signSubmitConfirm } from './submit';
import { loadTreasuryKeypair } from './wallet';

// The trust boundary: signer can only execute actions whose PolicyDecision is
// `allow`. The Extract<> in the parameter type makes that a compile-time check
// — only the policy engine can produce an `allow` decision, and only `allow`
// can be passed here.
export interface Signer {
  executeApproved(
    decision: Extract<PolicyDecision, { kind: 'allow' }>,
    opts: ExecuteOpts,
  ): Promise<ExecuteResult>;
  // Look up a previously-broadcast tx by signature. Used by the worker's
  // boot-time recovery loop. Exposed on the signer so the recovery path
  // doesn't need to know about RPC URLs or maintain its own Connection.
  checkSignatureStatus(signature: string): Promise<RecoveryStatus>;
}

export interface ExecuteOpts {
  // Persist the signature before submission so a crash mid-submit can be
  // recovered (re-confirm rather than re-submit). Worker passes a callback
  // backed by setActionTxSignature; if it throws (e.g., DB down, lost a CAS
  // race), the signer aborts before sendRawTransaction so we never broadcast
  // a tx whose signature isn't durably persisted.
  onSignature(signature: string): Promise<void>;
}

// Cluster's view of a previously-broadcast signature. `pending` covers both
// `processed` (on cluster but not yet voted) and `unknown` (RPC hasn't
// indexed yet) — the caller should NOT terminally transition such rows;
// leave them in `executing` for the next recovery sweep.
export type RecoveryStatus =
  | { kind: 'confirmed' }
  | { kind: 'reverted'; err: unknown }
  | { kind: 'pending' };

export interface SignerConfig {
  rpcUrl: string;
  keypairPath: string;
  commitment: Commitment;
  confirmTimeoutMs: number;
}

// Per-action program allowlists. The signer holds the keys, so it has final
// say over which programs may be CPI'd. Stricter than a global allowlist: if
// the Kamino SDK starts touching new programs, the deposit path catches it
// without widening trust for unrelated paths (e.g. the smoke transfer).
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

const KAMINO_DEPOSIT_ALLOWED_PROGRAMS = new Set<string>([
  KLEND_PROGRAM_ID_BASE58,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  SPL_TOKEN_PROGRAM,
  // First-time user setup creates a per-user lookup table.
  ADDRESS_LOOKUP_TABLE_PROGRAM,
]);

// Same set as deposit. By the time withdraw runs, the user's metadata + LUT
// already exist (created on the first deposit) so the LUT program normally
// won't appear, but the SDK occasionally emits LUT extension ixs on this
// path — keeping it in the allowlist avoids a spurious rejection.
const KAMINO_WITHDRAW_ALLOWED_PROGRAMS = new Set<string>([
  KLEND_PROGRAM_ID_BASE58,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  SPL_TOKEN_PROGRAM,
  ADDRESS_LOOKUP_TABLE_PROGRAM,
]);

const SMOKE_TRANSFER_ALLOWED_PROGRAMS = new Set<string>([SYSTEM_PROGRAM]);

// Phase 1, Step 2B: real Kamino Lend USDC deposit. Other venues/kinds fall
// through to the 2A self-transfer smoke instruction so every approved action
// still produces a real signature; demo stays uniform and the smoke path
// remains the known-good baseline for diagnosing protocol-layer breakage.
export function createSigner(config: SignerConfig): Signer {
  const connection = new Connection(config.rpcUrl, { commitment: config.commitment });
  const keypair = loadTreasuryKeypair(config.keypairPath);
  const treasuryAddress = keypair.publicKey.toBase58();
  console.log(
    `[signer] treasury=${treasuryAddress} rpc=${config.rpcUrl} commitment=${config.commitment}`,
  );

  // Loud banner when a development worker is pointed at mainnet. Easy mistake
  // to miss while iterating — every approved action signs real funds.
  // The check is heuristic: if NODE_ENV isn't `production` and the RPC URL
  // looks mainnet-shaped (any URL that isn't a local devnet/testnet endpoint
  // we recognise), warn. False positives are fine; this is just a heads-up.
  const looksLikeMainnet =
    !/devnet|testnet|localhost|127\.0\.0\.1/i.test(config.rpcUrl) &&
    process.env.NODE_ENV !== 'production';
  if (looksLikeMainnet) {
    console.warn(
      '[signer] ⚠️  RPC looks like mainnet and NODE_ENV is not `production`. ' +
        'Approved actions will sign REAL funds. Set NODE_ENV=production to silence.',
    );
  }

  return {
    async executeApproved(decision, opts) {
      const action = decision.action;

      // Source-wallet validation lives here, not in policy: policy doesn't
      // know which wallet the signer holds keys for. A mismatch means the
      // user asked us to sign from a wallet we don't custody — fail with a
      // typed reason rather than silently swapping in our own address.
      //
      // Today this also forces withdraw destinations to equal the treasury,
      // which is correct for a single-treasury demo but bakes in policy that
      // really lives elsewhere. When we support multi-wallet treasuries or
      // ops-controlled destinations, the destinationWallet check should move
      // to policy (which owns "where money may go"); the source-wallet check
      // stays here since "do I custody this key" is a signer concern.
      const declared =
        action.kind === 'deposit'
          ? action.sourceWallet
          : action.kind === 'withdraw'
            ? action.destinationWallet
            : null;
      if (declared !== null && declared !== treasuryAddress) {
        return {
          kind: 'failure',
          error: `wallet mismatch: action references ${declared}, treasury is ${treasuryAddress}`,
        };
      }

      let instructions: TransactionInstruction[];
      let allowedPrograms: Set<string>;
      if (action.kind === 'deposit' && action.venue === 'kamino') {
        instructions = await buildKaminoDepositInstructions(action, {
          connection,
          owner: keypair.publicKey,
        });
        allowedPrograms = KAMINO_DEPOSIT_ALLOWED_PROGRAMS;
      } else if (action.kind === 'withdraw' && action.venue === 'kamino') {
        instructions = await buildKaminoWithdrawInstructions(action, {
          connection,
          owner: keypair.publicKey,
        });
        allowedPrograms = KAMINO_WITHDRAW_ALLOWED_PROGRAMS;
      } else {
        // TODO(2D–2F): Drift, Marginfi, rebalance.
        instructions = [
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: keypair.publicKey,
            lamports: 0,
          }),
        ];
        allowedPrograms = SMOKE_TRANSFER_ALLOWED_PROGRAMS;
      }

      // Defense against a poisoned dependency or a malicious edit to a protocol
      // builder: the signer holds the keys, so it gets the final word on which
      // programs are allowed to be invoked. Per-action allowlists are stricter
      // than a single global one — if the SDK ever starts CPI'ing into an
      // unexpected program, this catches it.
      for (const ix of instructions) {
        const pid = ix.programId.toBase58();
        if (!allowedPrograms.has(pid)) {
          return {
            kind: 'failure',
            error: `disallowed program ${pid} in ${action.kind}`,
          };
        }
      }

      return signSubmitConfirm({
        connection,
        keypair,
        instructions,
        commitment: config.commitment,
        timeoutMs: config.confirmTimeoutMs,
        onSignature: opts.onSignature,
      });
    },

    async checkSignatureStatus(signature) {
      const value = await connection
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .then((r) => r.value[0])
        .catch(() => null);
      if (value?.err !== undefined && value?.err !== null) {
        return { kind: 'reverted', err: value.err };
      }
      if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') {
        return { kind: 'confirmed' };
      }
      return { kind: 'pending' };
    },
  };
}
