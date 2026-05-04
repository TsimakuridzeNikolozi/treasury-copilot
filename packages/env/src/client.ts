import { z } from 'zod';

// Reusable client-safe env schema fragments. Anything in here is shipped to the browser.
// Only `NEXT_PUBLIC_*` variables belong here.

export const publicAppUrlSchema = z.string().url().describe('Canonical public URL of the web app');

// TODO(phase-1): add public chain id / cluster name once we wire wallet UI.
