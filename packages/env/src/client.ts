import { z } from 'zod';

// Reusable client-safe env schema fragments. Anything in here is shipped to the browser.
// Only `NEXT_PUBLIC_*` variables belong here.

export const publicAppUrlSchema = z.string().url().describe('Canonical public URL of the web app');

// Privy app id — public-facing identifier. Pairs with `PRIVY_APP_SECRET`
// (server) to authenticate against Privy's API. Safe to ship to the browser;
// the secret stays server-side.
export const publicPrivyAppIdSchema = z.string().min(1).describe('Privy app id (public)');
