import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

// The argument Drizzle hands the `db.transaction(cb)` callback. Lacks
// `$client` (which is only on the outer Db) but otherwise has the same
// `.insert / .update / .select / .query` surface. Helpers that work both
// at top level and inside a tx accept `DbOrTx`.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Convenience for query helpers that don't care which one they got. Use
// this on helpers that may be called either from a route handler (Db)
// or from inside a `db.transaction(...)` block (Tx).
export type DbOrTx = Db | Tx;

export function createDb(connectionString: string) {
  const queryClient = postgres(connectionString, { max: 10 });
  return drizzle(queryClient, { schema });
}
