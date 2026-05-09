// Server-only. Never import from a client component or from apps/worker.
//
// This package wraps the parent-org admin half of the Turnkey API: minting
// new sub-orgs (one per user) and seeding each with a Solana wallet. The
// runtime signing path lives in @tc/signer/turnkey.ts and is unrelated.

export interface TurnkeyAdminConfig {
  // P-256 hex public + private key for the parent organization's admin API
  // key. Generated in the Turnkey dashboard under "Users → API Keys"; the
  // matching organization id is the parent org's UUID. Validated upstream
  // (see @tc/env's turnkey* schemas) — we don't re-validate here.
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
  // Parent-org API endpoint. Defaults to https://api.turnkey.com upstream.
  baseUrl: string;
}

export interface ProvisionTreasuryInput {
  // Becomes both the sub-org name and the root user's email. Email shows in
  // the Turnkey dashboard so operators can correlate sub-orgs to product
  // users; tolerate `null` because Privy may not surface an email for every
  // login method (SIWE, Passkey-only, etc.).
  ownerEmail: string | null;
  // Treasury display name — stored in `treasuries.name` and surfaced to the
  // user. Currently always 'Personal' but the param keeps the package
  // forward-compatible with M3's team treasuries.
  displayName: string;
}

export interface ProvisionTreasuryResult {
  // Sub-org's UUID. Persisted in `treasuries.turnkey_sub_org_id`. PR 3's
  // signer factory uses this to build a per-treasury Turnkey signer.
  subOrgId: string;
  // Wallet's UUID. Distinct from `walletAddress` (the base58 Solana address
  // used as `signWith`). PR 3 also persists this in
  // `treasuries.turnkey_wallet_id`.
  walletId: string;
  // Solana base58 pubkey of the wallet's first account (BIP44 path
  // m/44'/501'/0'/0'). This is the address the Solana cluster knows; signer
  // uses it as `signWith` and the wallet-mismatch check at
  // signer/src/index.ts:227-232 validates against it.
  walletAddress: string;
}

// Turnkey returned the sub-org but not the wallet. Stage 2 caller should
// surface this to a 502 with the orphaned subOrgId logged for operator
// reconcile (M3 adds an automatic reconciler).
export class TurnkeyProvisionError extends Error {
  readonly subOrgId: string | null;
  override readonly cause?: unknown;
  constructor(message: string, subOrgId: string | null, cause?: unknown) {
    super(message);
    this.name = 'TurnkeyProvisionError';
    this.subOrgId = subOrgId;
    this.cause = cause;
  }
}
