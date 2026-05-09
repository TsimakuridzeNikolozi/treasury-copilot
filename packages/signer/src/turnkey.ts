import { PublicKey } from '@solana/web3.js';
import { Turnkey } from '@turnkey/sdk-server';
import type { TreasurySigner } from './types';

export interface TurnkeySignerConfig {
  apiPublicKey: string;
  apiPrivateKey: string;
  baseUrl: string;
  organizationId: string;
  // Wallet account address Turnkey signs with — we pass it as `signWith` on
  // every request. Validated as a base58 Solana pubkey upstream so we can use
  // it as the `publicKey` directly without a boot-time API roundtrip.
  signWith: string;
  // Hard cap on a single Turnkey signing call. Without this, a stalled API
  // would pin the executor's tick. Enforced via Promise.race below.
  signTimeoutMs: number;
}

// Synchronous construction. We deliberately do NOT call Turnkey at boot —
// `publicKey` comes straight from `signWith` (already validated), so a
// Turnkey outage cannot prevent the worker from starting. The Turnkey
// client is built immediately (no network) and reused for every sign call.
export function createTurnkeyTreasurySigner(config: TurnkeySignerConfig): TreasurySigner {
  const turnkey = new Turnkey({
    apiBaseUrl: config.baseUrl,
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.organizationId,
  });
  const publicKey = new PublicKey(config.signWith);

  return {
    publicKey,
    async signSerializedMessage(message) {
      const payload = Buffer.from(message).toString('hex');

      // For Solana ed25519 signing, payload bytes are not pre-hashed —
      // ed25519 hashes internally. Turnkey requires HASH_FUNCTION_NOT_APPLICABLE
      // and PAYLOAD_ENCODING_HEXADECIMAL for raw transaction-message signing
      // (verified against @turnkey/solana's signRawPayload call site).
      const signPromise = turnkey.apiClient().signRawPayload({
        signWith: config.signWith,
        payload,
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
      });

      const TIMEOUT = Symbol('turnkey-sign-timeout');
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(TIMEOUT), config.signTimeoutMs);
      });

      let result: Awaited<typeof signPromise>;
      try {
        const raced = await Promise.race([signPromise, timeoutPromise]);
        if (raced === TIMEOUT) {
          throw new Error(`Turnkey signRawPayload timed out after ${config.signTimeoutMs}ms`);
        }
        result = raced;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // Ed25519 64-byte signature = r (32 bytes) || s (32 bytes), both as
      // hex strings on the response. The fields are documented as ECDSA
      // components but for ed25519 keys Turnkey returns the raw signature
      // halves; concatenating the hex matches the @turnkey/solana wrapper.
      const { r, s } = result;
      if (!r || !s) {
        throw new Error('Turnkey signRawPayload returned no signature components');
      }
      const sig = Buffer.from(`${r}${s}`, 'hex');
      if (sig.length !== 64) {
        throw new Error(`expected 64-byte ed25519 signature, got ${sig.length}`);
      }
      return new Uint8Array(sig);
    },
  };
}
