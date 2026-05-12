import { ChatClient } from '@/components/chat-client';
import type { SidebarSnapshot } from '@/components/chat/sidebar';
import { env } from '@/env';
import { db } from '@/lib/db';
import { proposedActionRowToHistoryDto } from '@/lib/dto/history';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';
import { Connection, PublicKey } from '@solana/web3.js';
import { getTreasuryById, listAddressBookEntries, listTransactionHistory } from '@tc/db';
import { getJupiterUsdcPosition, getJupiterUsdcSupplyApy } from '@tc/protocols/jupiter';
import { getKaminoUsdcPosition, getKaminoUsdcSupplyApy } from '@tc/protocols/kamino';
import { getSaveUsdcPosition, getSaveUsdcSupplyApy } from '@tc/protocols/save';
import { getWalletUsdcBalance } from '@tc/protocols/usdc';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Without `force-dynamic` the page can be statically prerendered
// and a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

// Module-scoped Connection so we don't reconstruct one per request.
// Mirrors the chat API route's pattern.
const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'confirmed' });

const SIDEBAR_HISTORY_LIMIT = 5;

export default async function ChatPage() {
  const { treasury } = await bootstrapAuthAndTreasury('/chat');
  const treasuryAddress = new PublicKey(treasury.walletAddress);

  // Parallel-fetch sidebar data + treasury record. Snapshot RPC reads can
  // throw (Kamino/Save SDK hiccups, RPC rate limits); on failure we render
  // the sidebar with snapshot=null and let the user fall back to the chat
  // agent's getTreasurySnapshot tool. Recent history + treasury row come
  // from postgres and basically can't fail.
  const [snapshotResult, treasuryRecord, recentRows, addressBookEntries] = await Promise.all([
    fetchSnapshot(treasuryAddress),
    getTreasuryById(db, treasury.id),
    listTransactionHistory(db, { treasuryId: treasury.id, limit: SIDEBAR_HISTORY_LIMIT }),
    listAddressBookEntries(db, treasury.id),
  ]);

  // Build the recipient-label map once so the DTO mapper can resolve
  // transfer-row labels without an N+1 lookup.
  const recipientLabels = new Map(
    addressBookEntries.map((e) => [e.recipientAddress, e.label] as const),
  );

  const recentHistory = recentRows.map((row) =>
    proposedActionRowToHistoryDto(row, { recipientLabels }),
  );

  // Telegram chip — username (not the chat id; chat id is opaque). We
  // don't have a stored bot/user name on the row; surface "On" with the
  // chat id excerpt if set, "Off" otherwise. Pre-PR chat sidebar mock
  // showed `@andre_treasurer` but that's a user-supplied display name we
  // don't persist; we use the chat id snippet here as a stand-in.
  const telegramUsername = treasuryRecord?.telegramChatId
    ? `tg:${treasuryRecord.telegramChatId.slice(0, 6)}…`
    : null;

  return (
    <ChatClient
      activeTreasuryId={treasury.id}
      treasuryName={treasury.name}
      telegramUsername={telegramUsername}
      snapshot={snapshotResult}
      recentHistory={recentHistory}
    />
  );
}

// Snapshot fan-out. Kamino + Save fail loudly (paired by Promise.all) —
// a hiccup in either means we'd be rendering partial data. Jupiter Lend
// uses Promise.allSettled because its SDK is pre-1.0 and prone to flake;
// a single Jupiter hiccup shouldn't blank the entire sidebar.
async function fetchSnapshot(treasuryAddress: PublicKey): Promise<SidebarSnapshot | null> {
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
      console.warn('[chat/sidebar] jupiter position read failed:', jupiterPosResult.reason);
    }
    if (jupiterApyResult.status === 'rejected') {
      console.warn('[chat/sidebar] jupiter apy read failed:', jupiterApyResult.reason);
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

    // Blended APY is supply-weighted across non-idle USDC; idle/wallet
    // earns nothing so it'd skew the rate downward misleadingly. When
    // Jupiter's read failed we exclude its position from the weighted
    // numerator AND denominator so the blended rate stays meaningful.
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
    // Worth a warn — operators may need to see the cause when staring
    // at a chat sidebar with no positions. The page still renders.
    console.warn('[chat/sidebar] snapshot fetch failed:', err);
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
