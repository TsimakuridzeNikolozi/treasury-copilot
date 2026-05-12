import { ChatClient } from '@/components/chat-client';
import { db } from '@/lib/db';
import { proposedActionRowToHistoryDto } from '@/lib/dto/history';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';
import { fetchSnapshot } from '@/lib/snapshot';
import { PublicKey } from '@solana/web3.js';
import { getTreasuryById, listAddressBookEntries, listTransactionHistory } from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Without `force-dynamic` the page can be statically prerendered
// and a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

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
