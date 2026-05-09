import { PRIVY_COOKIE } from '@/lib/privy-cookie';
import { type NextRequest, NextResponse } from 'next/server';

// Soft auth gate: redirect (or 401) unless the Privy access-token cookie is
// present. Strict verification (signature + expiry + issuer) lives in API
// route handlers and on the settings server page — Edge runtime makes
// fetching Privy's JWKS at every request awkward, and a cookie's mere
// presence is not trustworthy on its own.

export function middleware(req: NextRequest) {
  const hasToken = Boolean(req.cookies.get(PRIVY_COOKIE)?.value);
  if (hasToken) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith('/api/');
  if (isApi) {
    return new NextResponse('unauthorized', { status: 401 });
  }
  // Page route — redirect to landing with a `next` so we can return after login.
  const url = req.nextUrl.clone();
  url.pathname = '/';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

// `/api/me/bootstrap` and `/api/treasury/...` need the soft cookie
// presence gate so an unauthenticated client gets a 401 from middleware
// rather than reaching the strict-verify path inside the handler. They
// still call `verifyBearer` themselves — middleware is a fast pre-filter,
// not the auth boundary.
//
// `/api/auth/logout` is intentionally NOT in the matcher: it must work
// for users whose Privy cookie has already been invalidated client-side
// (browser back-button after sign-out, Privy session-expired race, etc.)
// so `tc_active_treasury` can still be cleared. POST-only, so an
// unauthenticated GET attempt 405s; the only "vulnerability" is that
// SameSite=Lax-permitted POSTs let CSRF force a treasury re-pick, which
// the route's own threat-model docstring already covers.
export const config = {
  matcher: [
    '/chat/:path*',
    '/settings/:path*',
    '/api/chat/:path*',
    '/api/policy/:path*',
    '/api/me/:path*',
    '/api/treasury/:path*',
  ],
};
