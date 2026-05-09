import { describe, expect, it } from 'vitest';
import { POST } from './route';

describe('POST /api/auth/logout', () => {
  it('204 + full-attribute clear on Set-Cookie (no auth needed)', async () => {
    const res = await POST();
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    // Full attribute parity is what makes browsers actually delete the
    // cookie. Drop any of these and Safari/Chrome may silently ignore
    // the deletion.
    expect(cookie).toContain('tc_active_treasury=');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  // Regression test: the route is excluded from the middleware matcher
  // so it's reachable without a Privy cookie. The handler itself takes
  // no Request object, so this test is functionally equivalent to the
  // one above — but locks in the contract that an unauthenticated
  // caller still gets the cookie clear (vs. middleware 401-ing them
  // and leaving tc_active_treasury sticky on the user's browser).
  it('clears the cookie even when called without a Privy session', async () => {
    const res = await POST();
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
