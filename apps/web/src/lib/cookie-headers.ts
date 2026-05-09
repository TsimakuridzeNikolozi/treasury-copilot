import { ACTIVE_TREASURY_COOKIE } from './active-treasury-cookie';

// 30 days. Long enough that switching back to a treasury after a week
// keeps the same cookie; short enough that an inactive cookie eventually
// expires on its own. Each interactive request renews it via Set-Cookie
// from the resolver, so an active user never re-types it.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

// Returns the exact `Set-Cookie` string for setting the active-treasury
// cookie. HttpOnly so JS can't read it (xss-resistance); Secure so it
// only travels over HTTPS in production; SameSite=Lax to block most CSRF
// while still letting normal top-level navigations carry it.
export function setActiveTreasuryCookie(treasuryId: string): string {
  return `${ACTIVE_TREASURY_COOKIE}=${treasuryId}; ${COOKIE_ATTRS}; Max-Age=${MAX_AGE_SECONDS}`;
}

// Mirrors `setActiveTreasuryCookie`'s attribute set exactly — only the
// value is empty and Max-Age is 0. Browsers only delete a cookie when
// the new Set-Cookie's `Path; HttpOnly; Secure; SameSite` triple
// matches the existing cookie's; dropping any of them silently fails
// the deletion in some browsers (especially Safari with strict ITP).
export function clearActiveTreasuryCookie(): string {
  return `${ACTIVE_TREASURY_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}
