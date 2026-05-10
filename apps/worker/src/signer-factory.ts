import { type Db, type TreasuryRow, getTreasuryForRouting } from '@tc/db';
import { type Signer, type SignerConfig, createSigner } from '@tc/signer';

// Subset of SignerConfig that is shared across all treasuries. Per-treasury
// fields (organizationId, signWith for turnkey; verified-against walletAddress
// for local) are resolved from the row inside the factory.
//
// Either localKeypairPath OR turnkeyParent must be set (matching the worker's
// SIGNER_BACKEND). The factory throws WorkerBackendMismatch if a treasury row
// asks for a backend the worker isn't configured for.
export interface BaseSignerConfig {
  rpcUrl: string;
  commitment: SignerConfig['commitment'];
  confirmTimeoutMs: number;
  signTimeoutMs: number;
  // Present iff the worker is in local mode. The factory passes this straight
  // to createSigner; it then verifies the keypair's public key matches the
  // treasury row's walletAddress.
  localKeypairPath?: string;
  // Parent Turnkey API creds (worker-level). Per-treasury organizationId +
  // signWith come from the row, not from here.
  turnkeyParent?: {
    apiPublicKey: string;
    apiPrivateKey: string;
    baseUrl: string;
  };
}

export interface SignerFactoryDeps {
  db: Db;
  baseConfig: BaseSignerConfig;
  // Default 100. Tests pass 2 to keep the eviction case sub-second.
  maxEntries?: number;
}

export interface SignerFactory {
  // Returns a cached or freshly-built per-treasury signer. The same
  // treasuryId always yields the same Signer instance until eviction.
  getSigner(treasuryId: string): Promise<Signer>;
}

// --- Structured errors -------------------------------------------------------

export class TreasuryNotFound extends Error {
  constructor(public readonly treasuryId: string) {
    super(`treasury ${treasuryId} not found`);
    this.name = 'TreasuryNotFound';
  }
}

export class TurnkeyTreasuryMalformed extends Error {
  constructor(
    public readonly treasuryId: string,
    public readonly missing: string,
  ) {
    super(`turnkey treasury ${treasuryId} malformed: ${missing} is null`);
    this.name = 'TurnkeyTreasuryMalformed';
  }
}

export class LocalKeypairMismatch extends Error {
  constructor(
    public readonly treasuryId: string,
    public readonly keypairAddress: string,
    public readonly treasuryAddress: string,
  ) {
    super(
      `local keypair address ${keypairAddress} does not match treasury ${treasuryId} wallet ${treasuryAddress}`,
    );
    this.name = 'LocalKeypairMismatch';
  }
}

// Worker SIGNER_BACKEND ≠ row.signer_backend, OR the worker is missing
// the env vars needed to satisfy the row's requested backend.
export class WorkerBackendMismatch extends Error {
  constructor(
    public readonly treasuryId: string,
    public readonly workerBackend: 'local' | 'turnkey',
    public readonly rowBackend: string,
    public readonly detail: string,
  ) {
    super(
      `worker backend ${workerBackend} cannot serve treasury ${treasuryId} (${rowBackend}): ${detail}`,
    );
    this.name = 'WorkerBackendMismatch';
  }
}

// --- Factory -----------------------------------------------------------------

// LRU cache: Map preserves insertion order; on hit we delete + reinsert to
// move the entry to the most-recent end; on insert overflow we evict the
// front (oldest). Inline implementation — no external dep, ~20 lines, easy
// to audit.
function createLru<V>(maxEntries: number) {
  const cache = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const v = cache.get(key);
      if (v === undefined) return undefined;
      cache.delete(key);
      cache.set(key, v);
      return v;
    },
    set(key: string, value: V): void {
      if (cache.has(key)) cache.delete(key);
      else if (cache.size >= maxEntries) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(key, value);
    },
    size(): number {
      return cache.size;
    },
  };
}

export function createSignerFactory(deps: SignerFactoryDeps): SignerFactory {
  const lru = createLru<Signer>(deps.maxEntries ?? 100);

  // Per-key in-flight promise dedup. Without this, two concurrent
  // getSigner(t1) calls during a cold start could both miss the cache,
  // both build a Signer, and the second would overwrite the first — at
  // best wasted work, at worst two Connection objects + two Turnkey
  // clients per treasury for no reason.
  const pending = new Map<string, Promise<Signer>>();

  return {
    async getSigner(treasuryId) {
      const cached = lru.get(treasuryId);
      if (cached) return cached;

      const inFlight = pending.get(treasuryId);
      if (inFlight) return inFlight;

      const build = (async () => {
        const row = await getTreasuryForRouting(deps.db, treasuryId);
        if (!row) throw new TreasuryNotFound(treasuryId);
        const signer = await buildSignerForRow(row, deps.baseConfig);
        lru.set(treasuryId, signer);
        return signer;
      })();
      pending.set(treasuryId, build);
      try {
        return await build;
      } finally {
        pending.delete(treasuryId);
      }
    },
  };
}

async function buildSignerForRow(row: TreasuryRow, baseConfig: BaseSignerConfig): Promise<Signer> {
  if (row.signerBackend === 'local') {
    if (!baseConfig.localKeypairPath) {
      throw new WorkerBackendMismatch(
        row.id,
        // worker backend must be turnkey here (no localKeypairPath set)
        'turnkey',
        row.signerBackend,
        'worker has no SOLANA_KEYPAIR_PATH; treasury wants local backend',
      );
    }
    const signer = createSigner({
      backend: 'local',
      rpcUrl: baseConfig.rpcUrl,
      keypairPath: baseConfig.localKeypairPath,
      commitment: baseConfig.commitment,
      confirmTimeoutMs: baseConfig.confirmTimeoutMs,
    });
    if (signer.treasuryAddress !== row.walletAddress) {
      throw new LocalKeypairMismatch(row.id, signer.treasuryAddress, row.walletAddress);
    }
    return signer;
  }

  if (row.signerBackend === 'turnkey') {
    if (!baseConfig.turnkeyParent) {
      throw new WorkerBackendMismatch(
        row.id,
        'local',
        row.signerBackend,
        'worker has no TURNKEY_API_* parent creds; treasury wants turnkey backend',
      );
    }
    if (!row.turnkeySubOrgId) {
      throw new TurnkeyTreasuryMalformed(row.id, 'turnkey_sub_org_id');
    }
    return createSigner({
      backend: 'turnkey',
      rpcUrl: baseConfig.rpcUrl,
      turnkey: {
        apiPublicKey: baseConfig.turnkeyParent.apiPublicKey,
        apiPrivateKey: baseConfig.turnkeyParent.apiPrivateKey,
        baseUrl: baseConfig.turnkeyParent.baseUrl,
        organizationId: row.turnkeySubOrgId,
        signWith: row.walletAddress,
      },
      commitment: baseConfig.commitment,
      confirmTimeoutMs: baseConfig.confirmTimeoutMs,
      signTimeoutMs: baseConfig.signTimeoutMs,
    });
  }

  // The CHECK constraint on treasuries.signer_backend rules this out at the
  // DB layer; the throw is defensive in case the constraint ever drops.
  throw new WorkerBackendMismatch(
    row.id,
    baseConfig.localKeypairPath ? 'local' : 'turnkey',
    row.signerBackend,
    'unknown signer_backend value',
  );
}
