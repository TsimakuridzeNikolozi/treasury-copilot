import {
  type Commitment,
  Connection,
  type Keypair,
  type PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  JUPITER_LEND_PROGRAM_ID_BASE58,
  buildJupiterDepositInstructions,
  buildJupiterWithdrawInstructions,
} from '@tc/protocols/jupiter';
import {
  KLEND_PROGRAM_ID_BASE58,
  buildKaminoDepositInstructions,
  buildKaminoWithdrawInstructions,
} from '@tc/protocols/kamino';
import {
  SAVE_PROGRAM_ID_BASE58,
  SAVE_WRAPPER_PROGRAM_ID_BASE58,
  buildSaveDepositInstructions,
  buildSaveWithdrawInstructions,
} from '@tc/protocols/save';
import type { ExecuteResult, PolicyDecision } from '@tc/types';
import { signSubmitConfirm } from './submit';
import { createTurnkeyTreasurySigner } from './turnkey';
import type { TreasurySigner } from './types';
import { createLocalKeypairTreasurySigner } from './wallet';

// The trust boundary: signer can only execute actions whose PolicyDecision is
// `allow`. The Extract<> in the parameter type makes that a compile-time check
// — only the policy engine can produce an `allow` decision, and only `allow`
// can be passed here.
export interface Signer {
  // Base58 of the treasury wallet this signer holds keys for. Exposed so the
  // worker's per-treasury factory can verify (in local mode) that the loaded
  // keypair matches the treasury row's wallet_address before caching.
  treasuryAddress: string;
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

// Discriminated by `backend` so adding new custody options later is additive
// (a new union member, the executor's tagged switch flags missing wiring).
export type SignerConfig =
  | {
      backend: 'local';
      rpcUrl: string;
      keypairPath: string;
      commitment: Commitment;
      confirmTimeoutMs: number;
    }
  | {
      backend: 'turnkey';
      rpcUrl: string;
      turnkey: {
        apiPublicKey: string;
        apiPrivateKey: string;
        baseUrl: string;
        organizationId: string;
        signWith: string;
      };
      commitment: Commitment;
      confirmTimeoutMs: number;
      // Hard cap on a single Turnkey sign call. Separate from
      // confirmTimeoutMs (which bounds post-broadcast confirmation only).
      signTimeoutMs: number;
    };

// Per-action program allowlists. The signer holds the keys, so it has final
// say over which programs may be CPI'd. Stricter than a global allowlist: if
// a protocol SDK starts touching new programs, the affected path catches it
// without widening trust for unrelated paths (e.g. the smoke transfer).
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
// Pyth pull-oracle infra (Save's setup ixs may inline a price update).
const PYTH_RECEIVER_PROGRAM = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
const WORMHOLE_CORE_PROGRAM = 'HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ';
// Switchboard On-Demand (Save's reserves with non-null switchboardOracle).
// USDC main-pool's switchboardOracle is the null sentinel today, but
// keeping the program in the allowlist avoids a regression if Save adds it.
const SWITCHBOARD_ONDEMAND_PROGRAM = 'SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv';

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

// Save (Solend rebrand) deposit. Save's lending program handles ATA setup,
// obligation init/refresh, and the deposit itself. The optional inline
// oracle ixs come from Pyth pull-receiver / Wormhole / Switchboard. The
// wrapper program is CPI'd by the max-deposit instruction variant; not our
// path today (we always pass an explicit amount) but allowlisted for
// symmetry with the withdraw path.
const SAVE_DEPOSIT_ALLOWED_PROGRAMS = new Set<string>([
  SAVE_PROGRAM_ID_BASE58,
  SAVE_WRAPPER_PROGRAM_ID_BASE58,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  SPL_TOKEN_PROGRAM,
  PYTH_RECEIVER_PROGRAM,
  WORMHOLE_CORE_PROGRAM,
  SWITCHBOARD_ONDEMAND_PROGRAM,
]);

// Save withdraw routes through the wrapper program (`withdrawExact`), which
// CPIs into the lending program. Plus the same supporting programs as
// deposit (oracle pulls, ATA, etc.).
const SAVE_WITHDRAW_ALLOWED_PROGRAMS = new Set<string>([
  SAVE_PROGRAM_ID_BASE58,
  SAVE_WRAPPER_PROGRAM_ID_BASE58,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  SPL_TOKEN_PROGRAM,
  PYTH_RECEIVER_PROGRAM,
  WORMHOLE_CORE_PROGRAM,
  SWITCHBOARD_ONDEMAND_PROGRAM,
]);

// Jupiter Lend (Earn) deposit. The SDK's getDepositIxs returns at most two
// outer ixs — an optional jlUSDC ATA-create and the deposit ix itself.
// CPIs to the SPL Token program (token transfer) and to Fluid's liquidity
// program happen inside the deposit ix, not at the outer tx level, so
// they don't need to appear in the allowlist. System + Compute Budget +
// SPL Token are kept here as defense-in-depth in case a future SDK minor
// version adds priority fee or pre-flight ixs — failing closed on a new
// program ID is the wrong default for an integration we own.
const JUPITER_DEPOSIT_ALLOWED_PROGRAMS = new Set<string>([
  JUPITER_LEND_PROGRAM_ID_BASE58,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  SPL_TOKEN_PROGRAM,
]);

// Same set for withdraw: the SDK pattern is symmetric (optional underlying-
// asset ATA-create + the withdraw ix).
const JUPITER_WITHDRAW_ALLOWED_PROGRAMS = new Set<string>([
  JUPITER_LEND_PROGRAM_ID_BASE58,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ATA_PROGRAM,
  SPL_TOKEN_PROGRAM,
]);

const SMOKE_TRANSFER_ALLOWED_PROGRAMS = new Set<string>([SYSTEM_PROGRAM]);

function buildTreasurySigner(config: SignerConfig): TreasurySigner {
  switch (config.backend) {
    case 'local':
      return createLocalKeypairTreasurySigner(config.keypairPath);
    case 'turnkey':
      return createTurnkeyTreasurySigner({
        apiPublicKey: config.turnkey.apiPublicKey,
        apiPrivateKey: config.turnkey.apiPrivateKey,
        baseUrl: config.turnkey.baseUrl,
        organizationId: config.turnkey.organizationId,
        signWith: config.turnkey.signWith,
        signTimeoutMs: config.signTimeoutMs,
      });
  }
}

// Phase 1, Step 2B: real Kamino Lend USDC deposit. Other venues/kinds fall
// through to the 2A self-transfer smoke instruction so every approved action
// still produces a real signature; demo stays uniform and the smoke path
// remains the known-good baseline for diagnosing protocol-layer breakage.
export function createSigner(config: SignerConfig): Signer {
  const connection = new Connection(config.rpcUrl, { commitment: config.commitment });
  const treasurySigner = buildTreasurySigner(config);
  const treasuryAddress = treasurySigner.publicKey.toBase58();
  console.log(
    `[signer] backend=${config.backend} treasury=${treasuryAddress} rpc=${config.rpcUrl} commitment=${config.commitment}`,
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

  const treasuryPubkey: PublicKey = treasurySigner.publicKey;

  return {
    treasuryAddress,
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
      let extraSigners: Keypair[];
      let allowedPrograms: Set<string>;
      const ctx = { connection, owner: treasuryPubkey };
      if (action.kind === 'deposit' && action.venue === 'kamino') {
        const built = await buildKaminoDepositInstructions(action, ctx);
        instructions = built.instructions;
        extraSigners = built.extraSigners;
        allowedPrograms = KAMINO_DEPOSIT_ALLOWED_PROGRAMS;
      } else if (action.kind === 'withdraw' && action.venue === 'kamino') {
        const built = await buildKaminoWithdrawInstructions(action, ctx);
        instructions = built.instructions;
        extraSigners = built.extraSigners;
        allowedPrograms = KAMINO_WITHDRAW_ALLOWED_PROGRAMS;
      } else if (action.kind === 'deposit' && action.venue === 'save') {
        const built = await buildSaveDepositInstructions(action, ctx);
        instructions = built.instructions;
        extraSigners = built.extraSigners;
        allowedPrograms = SAVE_DEPOSIT_ALLOWED_PROGRAMS;
      } else if (action.kind === 'withdraw' && action.venue === 'save') {
        const built = await buildSaveWithdrawInstructions(action, ctx);
        instructions = built.instructions;
        extraSigners = built.extraSigners;
        allowedPrograms = SAVE_WITHDRAW_ALLOWED_PROGRAMS;
      } else if (action.kind === 'deposit' && action.venue === 'jupiter') {
        const built = await buildJupiterDepositInstructions(action, ctx);
        instructions = built.instructions;
        extraSigners = built.extraSigners;
        allowedPrograms = JUPITER_DEPOSIT_ALLOWED_PROGRAMS;
      } else if (action.kind === 'withdraw' && action.venue === 'jupiter') {
        const built = await buildJupiterWithdrawInstructions(action, ctx);
        instructions = built.instructions;
        extraSigners = built.extraSigners;
        allowedPrograms = JUPITER_WITHDRAW_ALLOWED_PROGRAMS;
      } else {
        // Drift, Marginfi: deferred — still no builders.
        // Rebalance never reaches here — the executor decomposes it into
        // withdraw + deposit allow decisions via policy.deriveRebalanceLegs
        // and calls executeApproved twice. This branch only catches future
        // venues that lack builders.
        instructions = [
          SystemProgram.transfer({
            fromPubkey: treasuryPubkey,
            toPubkey: treasuryPubkey,
            lamports: 0,
          }),
        ];
        extraSigners = [];
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
        treasurySigner,
        instructions,
        extraSigners,
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
