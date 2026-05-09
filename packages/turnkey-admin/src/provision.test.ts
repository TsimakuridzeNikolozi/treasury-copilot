import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionTreasury } from './provision';
import { TurnkeyProvisionError } from './types';

// Mock the Turnkey SDK so the test never opens a real socket. We capture
// the body the SDK was called with so the test can assert payload shape.
const createSubOrganization = vi.fn();
vi.mock('@turnkey/sdk-server', () => ({
  Turnkey: vi.fn().mockImplementation(() => ({
    apiClient: () => ({ createSubOrganization }),
  })),
}));

const config = {
  apiPublicKey: 'a'.repeat(66),
  apiPrivateKey: 'b'.repeat(64),
  organizationId: '00000000-0000-4000-8000-000000000000',
  baseUrl: 'https://api.turnkey.com',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('provisionTreasury', () => {
  it('calls CreateSubOrganization with the embedded Solana wallet and returns the address', async () => {
    createSubOrganization.mockResolvedValue({
      subOrganizationId: 'sub-org-uuid',
      wallet: {
        walletId: 'wallet-uuid',
        addresses: ['HzkdEcKt5xR3wWqYxcujfBQ7CKsAhMfM4Pq8Lq3KQGfA'],
      },
      rootUserIds: ['root-user-uuid'],
    });

    const result = await provisionTreasury(config, {
      ownerEmail: 'alice@example.com',
      displayName: 'Personal',
    });

    expect(result).toEqual({
      subOrgId: 'sub-org-uuid',
      walletId: 'wallet-uuid',
      walletAddress: 'HzkdEcKt5xR3wWqYxcujfBQ7CKsAhMfM4Pq8Lq3KQGfA',
    });

    expect(createSubOrganization).toHaveBeenCalledTimes(1);
    const arg = createSubOrganization.mock.calls[0]?.[0];
    expect(arg.subOrganizationName).toBe('alice@example.com — Personal');
    expect(arg.rootQuorumThreshold).toBe(1);
    expect(arg.rootUsers).toHaveLength(1);
    expect(arg.rootUsers[0].userEmail).toBe('alice@example.com');
    expect(arg.rootUsers[0].apiKeys[0]).toEqual({
      apiKeyName: 'parent-admin',
      publicKey: config.apiPublicKey,
      curveType: 'API_KEY_CURVE_P256',
    });
    expect(arg.wallet.accounts[0]).toEqual({
      curve: 'CURVE_ED25519',
      pathFormat: 'PATH_FORMAT_BIP32',
      path: "m/44'/501'/0'/0'",
      addressFormat: 'ADDRESS_FORMAT_SOLANA',
    });
  });

  it('omits userEmail when ownerEmail is null and falls back to plain displayName', async () => {
    createSubOrganization.mockResolvedValue({
      subOrganizationId: 'sub-org-uuid',
      wallet: { walletId: 'w', addresses: ['HzkdEcKt5xR3wWqYxcujfBQ7CKsAhMfM4Pq8Lq3KQGfA'] },
    });

    await provisionTreasury(config, { ownerEmail: null, displayName: 'Personal' });

    const arg = createSubOrganization.mock.calls[0]?.[0];
    expect(arg.subOrganizationName).toBe('Personal');
    expect(arg.rootUsers[0].userEmail).toBeUndefined();
  });

  it('throws TurnkeyProvisionError with subOrgId when the wallet is missing from the response', async () => {
    createSubOrganization.mockResolvedValue({
      subOrganizationId: 'orphan-sub-org',
      // wallet absent — the partial-failure case the orchestrator must log.
    });

    await expect(
      provisionTreasury(config, { ownerEmail: 'a@b.c', displayName: 'Personal' }),
    ).rejects.toMatchObject({
      name: 'TurnkeyProvisionError',
      subOrgId: 'orphan-sub-org',
    });
  });

  it('throws TurnkeyProvisionError with subOrgId when the wallet has no addresses', async () => {
    createSubOrganization.mockResolvedValue({
      subOrganizationId: 'orphan-sub-org-2',
      wallet: { walletId: 'w', addresses: [] },
    });

    await expect(
      provisionTreasury(config, { ownerEmail: 'a@b.c', displayName: 'Personal' }),
    ).rejects.toMatchObject({
      name: 'TurnkeyProvisionError',
      subOrgId: 'orphan-sub-org-2',
    });
  });

  it('wraps SDK errors in TurnkeyProvisionError with no subOrgId (request never landed)', async () => {
    createSubOrganization.mockRejectedValue(new Error('network down'));

    const err = await provisionTreasury(config, {
      ownerEmail: 'a@b.c',
      displayName: 'Personal',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TurnkeyProvisionError);
    if (err instanceof TurnkeyProvisionError) {
      expect(err.subOrgId).toBeNull();
      expect(err.message).toContain('network down');
    }
  });
});
