import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

// numeric -> string (Drizzle's default) is kept: money is handled with decimal.js, never JS floats.

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/** Accepts a pool, or a single checked-out client when the caller owns a transaction. */
export function createDb(client: pg.Pool | pg.PoolClient): Db {
  return drizzle(client, { schema });
}
