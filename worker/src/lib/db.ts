/**
 * The worker's database handle.
 *
 * Deliberately NOT the app's `db/index.ts` client: that module reads
 * DATABASE_URL at import time, and a runner's `dotenv.config()` may not have
 * run yet when its imports are resolved. Here the connection is built lazily on
 * first use, so env loading order can't bite — and runs that never touch the
 * database (`--manual`, `npm run qa`) never open a connection at all.
 *
 * The schema itself IS shared with the app (../../../db/schema) — one source of
 * truth. worker/tsconfig.json compiles ../db/**, and worker/Dockerfile copies
 * db/ into the image, so this import resolves in both dev and the container.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: Sql | null = null;
let database: Db | null = null;

export function getDb(): Db {
  if (!database) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — the worker needs it to read the topic queue " +
          "and save articles. Add it to worker/.env, or run with --manual to " +
          "work from src/manual-topics.ts without touching the database."
      );
    }
    // `prepare: false` is required by Neon's connection pooler.
    // One connection is plenty: the pipeline processes topics sequentially.
    client = postgres(url, { prepare: false, max: 1 });
    database = drizzle(client, { schema });
  }
  return database;
}

/** Close the pool so the process can exit. Safe to call when never connected. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
    database = null;
  }
}
