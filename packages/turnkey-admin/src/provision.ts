import { Turnkey } from '@turnkey/sdk-server';
import {
  type ProvisionTreasuryInput,
  type ProvisionTreasuryResult,
  type TurnkeyAdminConfig,
  TurnkeyProvisionError,
} from './types';

// BIP44 path for Solana's primary account: 44 (purpose) / 501 (Solana
// SLIP-0044 coin type) / 0 (account) / 0 (change). Matches the path
// Turnkey's docs and @turnkey/solana use.
const SOLANA_BIP44_PATH = "m/44'/501'/0'/0'";

// `displayName` is composed into the sub-org name as `${ownerEmail} —
// ${displayName}` so operators scrolling the Turnkey dashboard can identify
// which product user owns which sub-org. When email is null we fall back to
// just `displayName`.
function buildSubOrgName(input: ProvisionTreasuryInput): string {
  const email = input.ownerEmail?.trim();
  return email ? `${email} — ${input.displayName}` : input.displayName;
}

// Provisions a new Turnkey sub-organization seeded with a Solana wallet.
//
// V7 of CreateSubOrganization accepts an embedded `wallet` parameter so the
// sub-org and its first wallet are created in a single API round-trip. The
// plan describes this conceptually as two calls (CreateSubOrganization
// then CreateWallet) but the V7 intent merges them — atomic on the
// Turnkey side, no orphan-sub-org-without-wallet failure mode.
//
// Auth model: the parent org's admin API key is registered as the sub-org's
// sole root user, which lets the parent's signer (in @tc/signer/turnkey.ts)
// use the new wallet via `signWith=<address>` plus
// `defaultOrganizationId=<subOrgId>` once PR 3's per-treasury signer
// factory ships. PR 2 does not yet route signing through these sub-orgs.
//
// Errors: TurnkeyProvisionError carries the subOrgId on the partial-failure
// path (sub-org created but wallet missing), so the caller can log it for
// reconciliation. Today V7's atomicity makes this branch effectively
// unreachable — kept for forward-compat in case Turnkey ever splits the
// intent.
export async function provisionTreasury(
  config: TurnkeyAdminConfig,
  input: ProvisionTreasuryInput,
): Promise<ProvisionTreasuryResult> {
  const turnkey = new Turnkey({
    apiBaseUrl: config.baseUrl,
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.organizationId,
  });

  type ApiClient = ReturnType<typeof turnkey.apiClient>;
  type CreateResponse = Awaited<ReturnType<ApiClient['createSubOrganization']>>;
  let response: CreateResponse;
  try {
    response = await turnkey.apiClient().createSubOrganization({
      subOrganizationName: buildSubOrgName(input),
      // Single root user = the parent org's admin API key. The parent
      // retains custody (via that key) so it can sign for the sub-org's
      // wallet. M3 may add per-user passkeys/email auth as additional
      // root credentials.
      rootUsers: [
        {
          userName: input.displayName,
          ...(input.ownerEmail ? { userEmail: input.ownerEmail } : {}),
          apiKeys: [
            {
              apiKeyName: 'parent-admin',
              publicKey: config.apiPublicKey,
              curveType: 'API_KEY_CURVE_P256',
            },
          ],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      rootQuorumThreshold: 1,
      wallet: {
        walletName: input.displayName,
        accounts: [
          {
            curve: 'CURVE_ED25519',
            pathFormat: 'PATH_FORMAT_BIP32',
            path: SOLANA_BIP44_PATH,
            addressFormat: 'ADDRESS_FORMAT_SOLANA',
          },
        ],
      },
    });
  } catch (cause) {
    throw new TurnkeyProvisionError(
      `Turnkey CreateSubOrganization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      null,
      cause,
    );
  }

  const subOrgId = response.subOrganizationId;
  const wallet = response.wallet;
  if (!wallet) {
    // V7 with an embedded `wallet` param always returns one on success;
    // missing here means the sub-org exists with no wallet attached —
    // operator must drop the sub-org via the Turnkey console and retry.
    throw new TurnkeyProvisionError('Turnkey CreateSubOrganization returned no wallet', subOrgId);
  }
  const walletAddress = wallet.addresses[0];
  if (!walletAddress) {
    throw new TurnkeyProvisionError(
      'Turnkey CreateSubOrganization returned a wallet with no addresses',
      subOrgId,
    );
  }

  return {
    subOrgId,
    walletId: wallet.walletId,
    walletAddress,
  };
}
