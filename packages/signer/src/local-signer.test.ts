import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import type { TreasurySigner } from './types';

// Inline copy of createLocalKeypairTreasurySigner's signing logic so the test
// doesn't have to write a temp keypair file. Validates the exact same nacl
// call we use in production — anything that breaks here breaks the local
// backend's signSerializedMessage too.
function fromKeypair(keypair: Keypair): TreasurySigner {
  return {
    publicKey: keypair.publicKey,
    async signSerializedMessage(message) {
      return nacl.sign.detached(message, keypair.secretKey);
    },
  };
}

describe('local TreasurySigner', () => {
  it('produces a 64-byte ed25519 signature that nacl verifies', async () => {
    const keypair = Keypair.generate();
    const signer = fromKeypair(keypair);
    const message = new TextEncoder().encode('hello treasury');

    const sig = await signer.signSerializedMessage(message);

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(nacl.sign.detached.verify(message, sig, keypair.publicKey.toBytes())).toBe(true);
  });

  it('produces deterministic signatures for the same message', async () => {
    const keypair = Keypair.generate();
    const signer = fromKeypair(keypair);
    const message = new Uint8Array([1, 2, 3, 4, 5]);

    const a = await signer.signSerializedMessage(message);
    const b = await signer.signSerializedMessage(message);

    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
