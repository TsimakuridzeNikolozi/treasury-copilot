import { env } from '@/env';
import { PrivyClient } from '@privy-io/server-auth';

// Privy's default access-token cookie name in modern config. Pinned here so a
// future Privy session-storage change is one edit rather than a hunt across
// middleware + server pages. If Privy renames it (unlikely but possible),
// the soft middleware gate breaks open — strict in-route verification stays
// the safety net.
export const PRIVY_COOKIE = 'privy-token';

// Module-scoped client — the SDK caches the JWT verification key after the
// first call (per the d.ts), so reusing one instance avoids hitting Privy's
// JWKS endpoint on every request.
const privy = new PrivyClient(env.NEXT_PUBLIC_PRIVY_APP_ID, env.PRIVY_APP_SECRET);

export { privy };

// Pulls the Bearer token from a request, verifies it against Privy, and
// returns the user's stable DID on success. Returns null on any failure
// (missing header, malformed token, expired token, signature mismatch) so
// API handlers can short-circuit with a 401 without try/catch boilerplate.
export async function verifyBearer(req: Request): Promise<{ userId: string } | null> {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
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
