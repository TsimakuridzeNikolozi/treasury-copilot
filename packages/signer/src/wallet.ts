import { readFileSync, statSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

// Loads a Solana CLI–format keypair (number[] of secret bytes) from disk.
// Runs once at worker boot; throwing here surfaces config errors loudly
// during startup, which is what we want.
export function loadTreasuryKeypair(path: string): Keypair {
  // Refuse group/world-readable keypair files. A 0644 keypair is a real risk
  // on shared dev machines and CI runners — the file is the entire wallet.
  // Skipped on Windows where POSIX mode bits don't apply.
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `treasury keypair at ${path} is group/world-readable (mode ${mode.toString(8)}); chmod 600 ${path}`,
      );
    }
  }

  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  // Solana CLI keypair = exactly 64 bytes (ed25519 secret + public). Without
  // a strict check, Uint8Array.from silently coerces NaN→0, truncates floats,
  // and wraps out-of-range values, which would yield a corrupted key with a
  // confusing downstream error.
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every(
      (n) =>
        typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n) && n >= 0 && n <= 255,
    )
  ) {
    throw new Error(
      `treasury keypair at ${path} is not in Solana CLI format (expected 64-byte array of integers 0..255)`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}
