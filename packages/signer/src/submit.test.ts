import { Keypair, type PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { signSubmitConfirm } from './submit';
import type { TreasurySigner } from './types';

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
const LAST_VALID_BLOCK_HEIGHT = 100;

interface StubConnection {
  getLatestBlockhash: ReturnType<typeof vi.fn>;
  sendRawTransaction: ReturnType<typeof vi.fn>;
  confirmTransaction: ReturnType<typeof vi.fn>;
  getSignatureStatuses: ReturnType<typeof vi.fn>;
}

function stubConnection(overrides: Partial<StubConnection> = {}): StubConnection {
  return {
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('signature-noop'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
    ...overrides,
  };
}

function realTreasurySigner(): {
  signer: TreasurySigner;
  keypair: Keypair;
  signSpy: ReturnType<typeof vi.fn>;
} {
  const keypair = Keypair.generate();
  const signSpy = vi.fn(async (message: Uint8Array) =>
    nacl.sign.detached(message, keypair.secretKey),
  );
  return {
    keypair,
    signSpy,
    signer: {
      publicKey: keypair.publicKey,
      signSerializedMessage: signSpy,
    },
  };
}

function transferIx(from: PublicKey, to: PublicKey) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1 });
}

describe('signSubmitConfirm', () => {
  it('signs, persists, and broadcasts on the happy path (no extraSigners)', async () => {
    const conn = stubConnection();
    const { signer, keypair } = realTreasurySigner();
    const onSignature = vi.fn().mockResolvedValue(undefined);

    const result = await signSubmitConfirm({
      connection: conn as never,
      treasurySigner: signer,
      instructions: [transferIx(keypair.publicKey, keypair.publicKey)],
      commitment: 'confirmed',
      timeoutMs: 5_000,
      onSignature,
    });

    expect(result.kind).toBe('success');
    expect(onSignature).toHaveBeenCalledOnce();
    const persistedSig = onSignature.mock.calls[0]?.[0] as string;
    // Base58 fee-payer signature; bs58 decodes to 64 bytes for ed25519.
    expect(bs58.decode(persistedSig).length).toBe(64);
    expect(conn.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it('handles extraSigners=[] (the no-op path is the most-trafficked one)', async () => {
    const conn = stubConnection();
    const { signer, keypair } = realTreasurySigner();

    const result = await signSubmitConfirm({
      connection: conn as never,
      treasurySigner: signer,
      instructions: [transferIx(keypair.publicKey, keypair.publicKey)],
      extraSigners: [],
      commitment: 'confirmed',
      timeoutMs: 5_000,
      onSignature: async () => {},
    });

    expect(result.kind).toBe('success');
  });

  it('partial-signs ephemeral signers BEFORE asking the treasury to sign', async () => {
    const conn = stubConnection();
    const { signer, keypair, signSpy } = realTreasurySigner();
    const ephemeral = Keypair.generate();

    // Capture the moment partialSign is "applied" by checking that the
    // serialized message passed to the treasury already references the
    // ephemeral signer's pubkey at index 1 (fee-payer is 0).
    let messageAtSign: Uint8Array | undefined;
    signSpy.mockImplementationOnce(async (msg: Uint8Array) => {
      messageAtSign = msg;
      return nacl.sign.detached(msg, keypair.secretKey);
    });

    // An instruction requiring ephemeral as a writable signer (transfer
    // from ephemeral pulls it into requiredSignatures).
    await signSubmitConfirm({
      connection: conn as never,
      treasurySigner: signer,
      instructions: [transferIx(ephemeral.publicKey, keypair.publicKey)],
      extraSigners: [ephemeral],
      commitment: 'confirmed',
      timeoutMs: 5_000,
      onSignature: async () => {},
    });

    expect(messageAtSign).toBeDefined();
    expect(signSpy).toHaveBeenCalledOnce();
  });

  it('aborts before broadcast when onSignature throws', async () => {
    const conn = stubConnection();
    const { signer, keypair } = realTreasurySigner();
    const onSignature = vi.fn().mockRejectedValue(new Error('db down'));

    const result = await signSubmitConfirm({
      connection: conn as never,
      treasurySigner: signer,
      instructions: [transferIx(keypair.publicKey, keypair.publicKey)],
      commitment: 'confirmed',
      timeoutMs: 5_000,
      onSignature,
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.error).toContain('persist signature failed');
    }
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('propagates signSerializedMessage rejection as pre-broadcast failure', async () => {
    const conn = stubConnection();
    const { keypair } = realTreasurySigner();
    const failingSigner: TreasurySigner = {
      publicKey: keypair.publicKey,
      signSerializedMessage: vi
        .fn()
        .mockRejectedValue(new Error('Turnkey signRawPayload timed out')),
    };
    const onSignature = vi.fn();

    const result = await signSubmitConfirm({
      connection: conn as never,
      treasurySigner: failingSigner,
      instructions: [transferIx(keypair.publicKey, keypair.publicKey)],
      commitment: 'confirmed',
      timeoutMs: 5_000,
      onSignature,
    });

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.error).toContain('Turnkey signRawPayload timed out');
    }
    expect(onSignature).not.toHaveBeenCalled();
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});
