import { type Connection, PublicKey } from '@solana/web3.js';

// Mainnet USDC mint. Same value as kamino.ts/save.ts; kept here so this helper
// is self-contained when read.
export const USDC_MINT_BASE58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT = new PublicKey(USDC_MINT_BASE58);

// Fetch the owner's USDC token-account balance (sum across all USDC accounts
// they hold; in practice it's just the single ATA). Returns a decimal string
// like "1.234567" with 6 fraction digits — same shape as ProposedAction.amountUsdc
// so the chat tool can render it without further conversion.
//
// `getParsedTokenAccountsByOwner` is preferred over computing the ATA + calling
// `getTokenAccountBalance` because it gracefully handles the "no ATA yet" case
// (returns an empty array instead of throwing) and avoids pulling
// @solana/spl-token just for ATA derivation. One RPC call regardless.
export async function getWalletUsdcBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<{ amountUsdc: string }> {
  const result = await connection.getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT });
  if (result.value.length === 0) {
    return { amountUsdc: '0' };
  }

  let total = 0n;
  for (const { account } of result.value) {
    // RPC returns amount as a decimal string of base units. Sum as BigInt to
    // avoid float precision loss across multiple accounts.
    const raw = (account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed
      .info.tokenAmount.amount;
    total += BigInt(raw);
  }

  // Format with 6 decimal places by string-slicing — avoids Decimal.js for the
  // hot path. "1234567" → "1.234567"; "0" → "0".
  if (total === 0n) return { amountUsdc: '0' };
  const s = total.toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return { amountUsdc: frac.length === 0 ? whole : `${whole}.${frac}` };
}
