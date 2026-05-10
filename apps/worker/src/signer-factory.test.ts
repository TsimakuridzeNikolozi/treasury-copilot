import type { Db } from '@tc/db';
import type { Signer } from '@tc/signer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTreasuryForRouting: vi.fn(),
  createSigner: vi.fn(),
}));

vi.mock('@tc/db', () => ({
  getTreasuryForRouting: mocks.getTreasuryForRouting,
}));

vi.mock('@tc/signer', () => ({
  createSigner: mocks.createSigner,
}));

const {
  createSignerFactory,
  TreasuryNotFound,
  TurnkeyTreasuryMalformed,
  LocalKeypairMismatch,
  WorkerBackendMismatch,
} = await import('./signer-factory');

afterEach(() => {
  vi.clearAllMocks();
});

const fakeDb = {} as Db;

const TURNKEY_BASE_CONFIG = {
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  commitment: 'confirmed' as const,
  confirmTimeoutMs: 60_000,
  signTimeoutMs: 10_000,
  turnkeyParent: {
    apiPublicKey: 'a'.repeat(66),
    apiPrivateKey: 'b'.repeat(64),
    baseUrl: 'https://api.turnkey.com',
  },
};

const LOCAL_BASE_CONFIG = {
  rpcUrl: 'http://localhost:8899',
  commitment: 'confirmed' as const,
  confirmTimeoutMs: 60_000,
  signTimeoutMs: 10_000,
  localKeypairPath: '/dev/null/keys/treasury.json',
};

function turnkeyRow(id = 'tid-1') {
  return {
    id,
    name: 'Personal',
    walletAddress: 'TurnkeyWallet1111111111111111111111111111111',
    turnkeySubOrgId: 'sub-org-uuid',
    turnkeyWalletId: 'wallet-uuid',
    signerBackend: 'turnkey' as const,
    telegramChatId: null,
    telegramApproverIds: [],
    createdAt: new Date(),
    createdBy: null,
  };
}

function localRow(id = 'tid-local') {
  return {
    id,
    name: 'Seed',
    walletAddress: 'LocalKeypairAddress11111111111111111111111111',
    turnkeySubOrgId: 'seed-stub-sub-org',
    turnkeyWalletId: null,
    signerBackend: 'local' as const,
    telegramChatId: null,
    telegramApproverIds: [],
    createdAt: new Date(),
    createdBy: null,
  };
}

function fakeSigner(treasuryAddress: string): Signer {
  return {
    treasuryAddress,
    executeApproved: vi.fn(),
    checkSignatureStatus: vi.fn(),
  };
}

describe('signer-factory', () => {
  it('cache hit returns the same Signer instance', async () => {
    const t = turnkeyRow();
    mocks.getTreasuryForRouting.mockResolvedValue(t);
    mocks.createSigner.mockReturnValue(fakeSigner(t.walletAddress));

    const factory = createSignerFactory({ db: fakeDb, baseConfig: TURNKEY_BASE_CONFIG });
    const a = await factory.getSigner('tid-1');
    const b = await factory.getSigner('tid-1');
    expect(a).toBe(b);
    expect(mocks.createSigner).toHaveBeenCalledTimes(1);
    expect(mocks.getTreasuryForRouting).toHaveBeenCalledTimes(1);
  });

  it('cache miss for a second treasury builds a fresh Signer', async () => {
    const t1 = turnkeyRow('tid-1');
    const t2 = {
      ...turnkeyRow('tid-2'),
      walletAddress: 'WalletTwo22222222222222222222222222222222222',
    };
    mocks.getTreasuryForRouting.mockImplementation(async (_db, id) => (id === 'tid-1' ? t1 : t2));
    mocks.createSigner.mockImplementation((cfg: { turnkey?: { signWith: string } }) =>
      fakeSigner(cfg.turnkey?.signWith ?? 'unknown'),
    );

    const factory = createSignerFactory({ db: fakeDb, baseConfig: TURNKEY_BASE_CONFIG });
    const a = await factory.getSigner('tid-1');
    const b = await factory.getSigner('tid-2');
    expect(a).not.toBe(b);
    expect(a.treasuryAddress).toBe(t1.walletAddress);
    expect(b.treasuryAddress).toBe(t2.walletAddress);
    expect(mocks.createSigner).toHaveBeenCalledTimes(2);
  });

  it('LRU eviction: oldest entry is rebuilt after overflow', async () => {
    const rows = ['a', 'b', 'c'].map((id) => ({
      ...turnkeyRow(id),
      walletAddress: `Wallet${id}1111111111111111111111111111111111111`,
    }));
    mocks.getTreasuryForRouting.mockImplementation(async (_db, id) =>
      rows.find((r) => r.id === id),
    );
    mocks.createSigner.mockImplementation((cfg: { turnkey?: { signWith: string } }) =>
      fakeSigner(cfg.turnkey?.signWith ?? 'unknown'),
    );

    // maxEntries=2: filling a, b, c evicts a; re-requesting a triggers a fresh build.
    const factory = createSignerFactory({
      db: fakeDb,
      baseConfig: TURNKEY_BASE_CONFIG,
      maxEntries: 2,
    });
    await factory.getSigner('a');
    await factory.getSigner('b');
    expect(mocks.createSigner).toHaveBeenCalledTimes(2);
    await factory.getSigner('c'); // evicts 'a'
    expect(mocks.createSigner).toHaveBeenCalledTimes(3);
    await factory.getSigner('a'); // miss → rebuild
    expect(mocks.createSigner).toHaveBeenCalledTimes(4);
    await factory.getSigner('c'); // still cached after eviction of 'b'
    expect(mocks.createSigner).toHaveBeenCalledTimes(4);
  });

  it('throws TreasuryNotFound for an unknown id', async () => {
    mocks.getTreasuryForRouting.mockResolvedValue(null);
    const factory = createSignerFactory({ db: fakeDb, baseConfig: TURNKEY_BASE_CONFIG });
    await expect(factory.getSigner('does-not-exist')).rejects.toBeInstanceOf(TreasuryNotFound);
  });

  it('throws TurnkeyTreasuryMalformed when sub_org_id is null', async () => {
    mocks.getTreasuryForRouting.mockResolvedValue({ ...turnkeyRow(), turnkeySubOrgId: null });
    const factory = createSignerFactory({ db: fakeDb, baseConfig: TURNKEY_BASE_CONFIG });
    await expect(factory.getSigner('tid-1')).rejects.toBeInstanceOf(TurnkeyTreasuryMalformed);
    expect(mocks.createSigner).not.toHaveBeenCalled();
  });

  it('local backend, matching keypair: happy path', async () => {
    const row = localRow();
    mocks.getTreasuryForRouting.mockResolvedValue(row);
    mocks.createSigner.mockReturnValue(fakeSigner(row.walletAddress));

    const factory = createSignerFactory({ db: fakeDb, baseConfig: LOCAL_BASE_CONFIG });
    const signer = await factory.getSigner(row.id);
    expect(signer.treasuryAddress).toBe(row.walletAddress);
  });

  it('local backend, mismatched wallet: throws LocalKeypairMismatch', async () => {
    const row = localRow();
    mocks.getTreasuryForRouting.mockResolvedValue(row);
    mocks.createSigner.mockReturnValue(fakeSigner('Different11111111111111111111111111111111111'));

    const factory = createSignerFactory({ db: fakeDb, baseConfig: LOCAL_BASE_CONFIG });
    await expect(factory.getSigner(row.id)).rejects.toBeInstanceOf(LocalKeypairMismatch);
  });

  it('worker local + treasury turnkey: throws WorkerBackendMismatch', async () => {
    mocks.getTreasuryForRouting.mockResolvedValue(turnkeyRow());
    const factory = createSignerFactory({ db: fakeDb, baseConfig: LOCAL_BASE_CONFIG });
    await expect(factory.getSigner('tid-1')).rejects.toBeInstanceOf(WorkerBackendMismatch);
    expect(mocks.createSigner).not.toHaveBeenCalled();
  });

  it('worker turnkey + treasury local: throws WorkerBackendMismatch', async () => {
    mocks.getTreasuryForRouting.mockResolvedValue(localRow());
    const factory = createSignerFactory({ db: fakeDb, baseConfig: TURNKEY_BASE_CONFIG });
    await expect(factory.getSigner('tid-local')).rejects.toBeInstanceOf(WorkerBackendMismatch);
    expect(mocks.createSigner).not.toHaveBeenCalled();
  });

  it('concurrent getSigner for same id dedupes to one createSigner call', async () => {
    const row = turnkeyRow();
    let resolveLookup!: (value: typeof row) => void;
    const lookup = new Promise<typeof row>((resolve) => {
      resolveLookup = resolve;
    });
    mocks.getTreasuryForRouting.mockReturnValue(lookup);
    mocks.createSigner.mockReturnValue(fakeSigner(row.walletAddress));

    const factory = createSignerFactory({ db: fakeDb, baseConfig: TURNKEY_BASE_CONFIG });
    const aPromise = factory.getSigner('tid-1');
    const bPromise = factory.getSigner('tid-1');
    resolveLookup(row);
    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a).toBe(b);
    expect(mocks.createSigner).toHaveBeenCalledTimes(1);
    expect(mocks.getTreasuryForRouting).toHaveBeenCalledTimes(1);
  });
});
