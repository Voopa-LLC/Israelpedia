/**
 * The on/off switch, read from the database.
 *
 * The admin panel and this worker run on different hosts and cannot reach each
 * other, so the switch is a row in `pipeline_control` that both sides touch:
 * the panel writes `enabled`, this module polls it and writes back what the
 * worker is actually doing.
 *
 * ONE QUERY DOES BOTH. `syncControl()` stamps the heartbeat and returns
 * `enabled` from the same UPDATE ... RETURNING, so a poll costs a single round
 * trip to Neon rather than two.
 *
 * The result is cached, and the pipeline loop reads the cache synchronously —
 * checking a boolean between topics, never awaiting a query in the hot path.
 * Worst case the switch is acted on one poll interval late, which for a
 * pipeline whose unit of work takes fifteen minutes is immediate.
 *
 * FAILS SAFE. If the query throws — the table is missing, Neon is down, the
 * credentials are wrong — the cached answer becomes `false` and the pipeline
 * pauses. A worker that cannot confirm it is meant to be running must not spend
 * money assuming that it is.
 */
import { eq, sql } from "drizzle-orm";
import { pipelineControl } from "../../../db/schema";
import { getDb } from "./db";

/**
 * What the worker is doing, for the admin panel.
 *
 *   off           the switch is off; nothing is being claimed
 *   idle          switched on, but the queue has no pending topics
 *   working       processing a topic right now
 *   misconfigured cannot run at all — see the note (e.g. a missing API key)
 */
export type WorkerState = "off" | "idle" | "working" | "misconfigured";

// ── What this worker reports about itself ────────────────────────────────────
let state: WorkerState = "off";
let topic: string | null = null;
let note: string | null = null;

/**
 * Record what the worker is doing. Cheap and synchronous — it only updates the
 * values the next heartbeat will carry, so it can be called freely.
 */
export function reportState(
  next: WorkerState,
  options: { topic?: string | null; note?: string | null } = {}
): void {
  state = next;
  topic = options.topic ?? null;
  note = options.note ?? null;
}

// ── The cached answer to "should I be running?" ──────────────────────────────
let enabled = false;
/** Set once the first sync has actually reached the database. */
let everSynced = false;

/** Is the pipeline switched on? Synchronous: the last polled answer. */
export function pipelineEnabled(): boolean {
  return enabled;
}

/** Has the switch ever been read successfully? False means we are flying blind. */
export function controlReachable(): boolean {
  return everSynced;
}

/**
 * Stamp the heartbeat and read the switch, in one statement.
 *
 * Deliberately an UPDATE and not an upsert: the row is created by the migration
 * (db/migrations/0003_pipeline_control.sql). If it is missing, the migration has
 * not been run, and silently inventing the row here would hide that — so it is
 * reported and the pipeline stays off.
 */
export async function syncControl(): Promise<boolean> {
  try {
    const [row] = await getDb()
      .update(pipelineControl)
      .set({
        workerState: state,
        workerNote: note,
        workerTopic: topic,
        // The DATABASE's clock, not this process's.
        //
        // The heartbeat's only job is to be compared against `now()` by the
        // admin panel, running on a third machine. Sending a JS Date makes that
        // comparison depend on two processes agreeing about the time — and
        // `timestamp` columns carry no zone, so postgres-js reads them back
        // shifted by whatever TZ the reader happens to run in. Stamping and
        // comparing in SQL keeps both halves in one frame of reference.
        workerSeenAt: sql`now()`,
      })
      .where(eq(pipelineControl.id, true))
      .returning({ enabled: pipelineControl.enabled });

    if (!row) {
      if (everSynced || enabled) {
        console.error(
          "[Control] The pipeline_control row is missing. Run `npm run db:migrate-pipeline`. " +
            "Staying off until it exists."
        );
      }
      enabled = false;
      return false;
    }

    if (!everSynced) {
      console.log(`[Control] Switch read from the database: ${row.enabled ? "ON" : "OFF"}.`);
      everSynced = true;
    } else if (row.enabled !== enabled) {
      console.log(`[Control] Switch changed → ${row.enabled ? "ON" : "OFF"}.`);
    }

    enabled = row.enabled;
    return enabled;
  } catch (err) {
    // A blip must pause the pipeline, not kill the container.
    console.error(
      `[Control] Could not read the switch: ${err instanceof Error ? err.message : String(err)}. ` +
        "Pausing until the next poll."
    );
    enabled = false;
    return false;
  }
}

/**
 * Poll the switch on a timer, forever.
 *
 * setTimeout chained rather than setInterval so a slow query can never overlap
 * itself. Returns a function that stops it.
 *
 * This is also the heartbeat: it keeps running while a topic is being written,
 * which is the point — a topic takes fifteen minutes or more, and a heartbeat
 * that only beat between topics would make a healthy worker look dead.
 */
export function startControlSync(intervalMs: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await syncControl();
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  timer = setTimeout(() => void tick(), intervalMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Last word before the process exits: say the worker is gone.
 *
 * Without this the panel would show whatever the final heartbeat said until it
 * went stale, so a clean redeploy would look like a crash for a minute or two.
 */
export async function reportStopped(reason: string): Promise<void> {
  reportState("off", { note: reason });
  await syncControl().catch(() => {});
}
