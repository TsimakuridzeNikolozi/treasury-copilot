import { type Db, createDb } from '@tc/db';
import { env } from './env';

// Module-scoped client so the bot, the poller, and the callback handler share
// a single postgres-js connection pool. createDb opens `max: 10` per call.
export const db: Db = createDb(env.DATABASE_URL);
