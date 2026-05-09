import { env } from '@/env';
import { PrivyClient } from '@privy-io/server-auth';

// Re-export the cookie constant from the edge-safe module so existing
// imports (settings server page, components) keep resolving here. The
// literal itself lives in lib/privy-cookie.ts so middleware (Edge) can
// consume it without pulling the Privy SDK into the edge bundle.
export { PRIVY_COOKIE } from './privy-cookie';

// Module-scoped client — the SDK caches the JWT verification key after the
// first call (per the d.ts), so reusing one instance avoids hitting Privy's
// JWKS endpoint on every request.
const privy = new PrivyClient(env.NEXT_PUBLIC_PRIVY_APP_ID, env.PRIVY_APP_SECRET);

export { privy };

// Pulls the Bearer token from a request, verifies it against Privy, and
// returns the user's stable DID on success. Returns null on any failure
// (missing header, malformed token, expired token, signature mismatch) so
// API handlers can short-circuit with a 401 without try/catch boilerplate.
//
// Headers.get is case-insensitive per the Fetch spec — one lookup is
// sufficient for both 'Authorization' and 'authorization'.
export async function verifyBearer(req: Request): Promise<{ userId: string } | null> {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const claims = await privy.verifyAuthToken(token);
    return { userId: claims.userId };
  } catch {
    return null;
  }
}
