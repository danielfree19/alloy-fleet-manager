import pg from "pg";

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): DbPool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", (err) => {
    // Swallow; individual query errors are handled at call sites.
    // eslint-disable-next-line no-console
    console.error("[pg pool] idle client error", err);
  });
  return pool;
}
