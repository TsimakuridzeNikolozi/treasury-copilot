import { env } from '@/env';
import { createDb } from '@tc/db';

// Single process-wide postgres-js pool for the web app. Calling createDb in
// each route module spawns a fresh pool of 10 connections per file — across
// HMR reloads in dev, that exhausts Postgres `max_connections` quickly.
// Sharing one instance is cheap because Node module caching already
// dedupes; this just makes the contract explicit.
export const db = createDb(env.DATABASE_URL);
