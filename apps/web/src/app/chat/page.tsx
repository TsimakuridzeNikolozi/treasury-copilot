import { ChatClient } from '@/components/chat-client';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Without `force-dynamic` the page can be statically prerendered
// and a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const { treasury } = await bootstrapAuthAndTreasury('/chat');
  return <ChatClient activeTreasuryId={treasury.id} treasuryName={treasury.name} />;
}
