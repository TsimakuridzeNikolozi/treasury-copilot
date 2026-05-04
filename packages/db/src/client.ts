import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  const queryClient = postgres(connectionString, { max: 10 });
  return drizzle(queryClient, { schema });
}
