import type { PublicKey } from '@solana/web3.js';

// The internal abstraction over how the fee-payer signature is produced. Two
// implementations: a local-keypair backend that calls nacl directly, and a
// Turnkey backend that delegates to an HSM-backed API. Lives inside @tc/signer
// — never re-exported from the package root, since the trust boundary is the
// outer `Signer.executeApproved` interface (which only accepts allow
// decisions). Adding a TreasurySigner subclass externally would not let you
// bypass that.
//
// `signSerializedMessage` (not `signMessage`) is intentional: the bytes we
// pass are `Transaction#serializeMessage()` output, distinct from the
// wallet-standard off-chain `signMessage` and from `Keypair.sign`.
export interface TreasurySigner {
  readonly publicKey: PublicKey;
  signSerializedMessage(message: Uint8Array): Promise<Uint8Array>;
}
