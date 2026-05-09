import { ChatClient } from '@/components/chat-client';
import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { PRIVY_COOKIE, privy } from '@/lib/privy';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Without `force-dynamic` the page can be statically prerendered
// and a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  // Strict server-side auth check before any DB read. Middleware
  // soft-gates on cookie presence; here we verify the JWT
  // signature/expiry/issuer.
  const cookieStore = await cookies();
  const token = cookieStore.get(PRIVY_COOKIE)?.value;
  if (!token) redirect('/?next=/chat');
  let claims: { userId: string };
  try {
    const verified = await privy.verifyAuthToken(token);
    claims = { userId: verified.userId };
  } catch {
    redirect('/?next=/chat');
  }

  // Construct a Request-like object with just the cookie header — that's
  // the only thing resolveActiveTreasury reads (see readCookie in
  // active-treasury.ts). We deliberately don't spread the rest of the
  // page's headers; the resolver doesn't use them and including them
  // would muddy what this object is for.
  const cookieHeader = cookieStore.toString();
  const fakeReq = new Request('http://internal/chat', {
    headers: { cookie: cookieHeader },
  });

  const resolved = await resolveActiveTreasury(fakeReq, db, claims.userId);
  if ('onboardingRequired' in resolved) {
    redirect('/');
  }
  // Note: we deliberately don't write the cookie here even when the
  // resolver returned `setCookieHeader`. Next 15 forbids cookie mutations
  // from async server components on a GET render — only Route Handlers
  // and Server Actions can. The cookie self-heals on the next API
  // request (chat send / switcher fetch), all of which go through
  // `resolveActiveTreasury` and can attach the corrected Set-Cookie to
  // their response. The page itself renders correctly because we pass
  // `resolved.treasury.id` to the client component as a prop, not the
  // cookie.

  return <ChatClient activeTreasuryId={resolved.treasury.id} />;
}
