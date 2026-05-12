import type { SidebarSnapshot } from '@/components/chat/sidebar';
import { env } from '@/env';
import { Connection, type PublicKey } from '@solana/web3.js';
import { getJupiterUsdcPosition, getJupiterUsdcSupplyApy } from '@tc/protocols/jupiter';
import { getKaminoUsdcPosition, getKaminoUsdcSupplyApy } from '@tc/protocols/kamino';
import { getSaveUsdcPosition, getSaveUsdcSupplyApy } from '@tc/protocols/save';
import { getWalletUsdcBalance } from '@tc/protocols/usdc';

// Module-scoped Connection shared across all callers in this process.
// Mirrors the chat API route's pattern.
const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'confirmed' });

// Snapshot fan-out. Kamino + Save fail loudly (paired by Promise.all) —
// a hiccup in either means we'd be rendering partial data. Jupiter Lend
// uses Promise.allSettled because its SDK is pre-1.0 and prone to flake;
// a single Jupiter hiccup shouldn't blank the entire sidebar.
export async function fetchSnapshot(treasuryAddress: PublicKey): Promise<SidebarSnapshot | null> {
  try {
    const [walletUsdc, kaminoPos, kaminoApy, savePos, saveApy] = await Promise.all([
      getWalletUsdcBalance(connection, treasuryAddress),
      getKaminoUsdcPosition(connection, treasuryAddress),
      getKaminoUsdcSupplyApy(connection),
      getSaveUsdcPosition(connection, treasuryAddress),
      getSaveUsdcSupplyApy(connection),
    ]);

    const [jupiterPosResult, jupiterApyResult] = await Promise.allSettled([
      getJupiterUsdcPosition(connection, treasuryAddress),
      getJupiterUsdcSupplyApy(connection),
    ]);
    if (jupiterPosResult.status === 'rejected') {
      console.warn('[snapshot] jupiter position read failed:', jupiterPosResult.reason);
    }
    if (jupiterApyResult.status === 'rejected') {
      console.warn('[snapshot] jupiter apy read failed:', jupiterApyResult.reason);
    }
    const jupiterAmount =
      jupiterPosResult.status === 'fulfilled' ? jupiterPosResult.value.amountUsdc : null;
    const jupiterApy =
      jupiterApyResult.status === 'fulfilled' ? jupiterApyResult.value.apyDecimal : null;

    const wallet = parseUsdcAmount(walletUsdc.amountUsdc);
    const k = parseUsdcAmount(kaminoPos.amountUsdc);
    const s = parseUsdcAmount(savePos.amountUsdc);
    const j = parseUsdcAmount(jupiterAmount);
    const totalNum = wallet + k + s + j;
    const positionsSum = k + s + j;

    let blendedDecimal: number | null = null;
    if (positionsSum > 0) {
      let weightedSum = k * kaminoApy.apyDecimal + s * saveApy.apyDecimal;
      let weight = k + s;
      if (jupiterApy !== null && j > 0) {
        weightedSum += j * jupiterApy;
        weight += j;
      }
      blendedDecimal = weight > 0 ? weightedSum / weight : null;
    }

    return {
      totalUsdc: formatUsdc(totalNum),
      walletUsdc: formatUsdc(wallet),
      blendedApyPct: blendedDecimal !== null ? formatPct(blendedDecimal) : null,
      positions: [
        { venue: 'kamino', amountUsdc: formatUsdc(k), apyPct: formatPct(kaminoApy.apyDecimal) },
        { venue: 'save', amountUsdc: formatUsdc(s), apyPct: formatPct(saveApy.apyDecimal) },
        {
          venue: 'jupiter',
          amountUsdc: formatUsdc(j),
          apyPct: jupiterApy !== null ? formatPct(jupiterApy) : null,
        },
      ],
    };
  } catch (err) {
    console.warn('[snapshot] fetch failed:', err);
    return null;
  }
}

function formatUsdc(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseUsdcAmount(amount: string | null): number {
  const parsed = amount !== null ? Number.parseFloat(amount) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPct(decimal: number): string {
  return `${(decimal * 100).toFixed(2)}%`;
}
