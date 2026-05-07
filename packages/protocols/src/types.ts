import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';

// Shared context passed to every protocol builder. The signer holds the
// keypair; protocols only see the public key. `connection` is the live RPC
// — builders may wrap it (e.g. withFinalizedSlot for stale-slot mitigation)
// before handing it to protocol SDKs.
export interface ProtocolCtx {
  connection: Connection;
  owner: PublicKey;
}

// Standard return shape for every protocol builder. `instructions` is the
// flat list to sign, in submission order. `extraSigners` is any ephemeral
// signers required by individual ixs (e.g. Pyth pull-oracle keypairs the
// Save SDK emits, or fresh-account init keypairs other protocols use). The
// fee payer (treasury) is added by the signer separately and is always
// signatures[0]; extraSigners contribute additional signatures only.
export interface BuiltInstructions {
  instructions: TransactionInstruction[];
  extraSigners: Keypair[];
}
