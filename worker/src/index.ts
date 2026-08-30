/**
 * The worker service. This is what runs in the cloud (Railway) — the process
 * the container starts, and the only thing that publishes articles
 * automatically.
 *
 * It works the `topics` queue continuously and writes only to the database. See
 * src/pipeline.ts for the loop itself.
 *
 * STARTING AND STOPPING IS NOT DONE HERE. The switch is a row in the database,
 * flipped from /admin/topics, and the worker polls it every few seconds (see
 * lib/pipeline-control.ts). So the container should simply be left running:
 * booting it does not start the pipeline, and stopping the pipeline does not
 * stop the container. It starts OFF — the switch is seeded off by
 * db/migrations/0003_pipeline_control.sql — so a fresh deploy never begins
 * spending on its own.
 *
 * Environment — tuning only, all optional except DATABASE_URL and the API keys:
 *   PIPELINE_VARIANT           perplexity (default) | claude | gpt
 *   PIPELINE_DELAY_MS          pause between topics (default 5000)
 *   PIPELINE_IDLE_POLL_MS      how often to re-check an empty queue (default 60000)
 *   PIPELINE_CONTROL_POLL_MS   how often to re-read the switch (default 20000)
 *   PIPELINE_MAX_TOPICS        stop after N topics and idle (default: no cap)
 *   PIPELINE_REVIEW=true       hold articles in the review queue, don't publish
 *
 * SHUTDOWN. A redeploy sends SIGTERM and then kills the process shortly after,
 * which is not long enough to finish an article. So the handler stops the loop
 * and hands the in-flight topic straight back to the queue: the row returns to
 * `pending` and the next boot picks it up, instead of sitting in `running`
 * until requeueStale() reclaims it 90 minutes later.
 */
import dotenv from "dotenv";
dotenv.config();

import { activeTopicId } from "./lib/drain-queue";
import { closeDb } from "./lib/db";
import {
  reportState,
  reportStopped,
  startControlSync,
  syncControl,
} from "./lib/pipeline-control";
import { releaseTopic } from "./lib/topics-queue";
import { describeConfig, serviceConfig } from "./lib/service-config";
import { runPipelineForever } from "./pipeline";
import { researchKeyVars } from "./run-config";

const config = serviceConfig();

let running = true;
const isRunning = () => running;
let stopControlSync: (() => void) | null = null;

/**
 * Every key this run needs but does not have.
 *
 * Missing keys are NOT fatal here. The switch is off at boot, so a container
 * that exits over a key nobody needs yet is just a crash loop in the dashboard;
 * and once it is running, exiting would take the heartbeat with it and the
 * panel would show a dead worker rather than the actual problem. Instead the
 * worker stays up, reports `misconfigured`, and names what is missing.
 */
function missingKeys(): string[] {
  const missing: string[] = [];
  const researchVars = researchKeyVars(config.variant);
  if (!researchVars.some((name) => process.env[name])) {
    missing.push(researchVars.join(" or "));
  }
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  return missing;
}

/** Stop the loop, release the claimed topic, say we have gone, exit. */
async function shutdown(signal: string): Promise<void> {
  if (!running) return; // a second signal while the first is still unwinding
  running = false;
  console.log(`\n[Service] ${signal} received — shutting down.`);

  stopControlSync?.();

  const id = activeTopicId();
  if (id) {
    try {
      await releaseTopic(id);
      console.log("[Service] In-flight topic returned to the queue.");
    } catch (err) {
      console.error(
        "[Service] Could not release the in-flight topic — it will be re-queued " +
          "automatically within 90 minutes:",
        err
      );
    }
  }

  // So the panel says "the worker is gone" straight away, instead of showing a
  // stale heartbeat until it ages out.
  await reportStopped(`Worker shut down (${signal}).`);

  await closeDb().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("Worker started.");

  if (!process.env.DATABASE_URL) {
    // The one genuinely fatal case: without the database there is no switch to
    // read, no queue to work, and nowhere to report the problem.
    console.error("DATABASE_URL is not set — the worker cannot reach the switch or the queue.");
    process.exit(1);
  }

  const missing = missingKeys();
  if (missing.length > 0) {
    const note = `Missing on the worker service: ${missing.join(", ")}.`;
    console.error(`[Service] ${note} The pipeline cannot run until these are set.`);
    reportState("misconfigured", { note });
    // Keep reporting it, so the reason is visible at /admin/topics rather than
    // buried in the deployment logs.
    await syncControl();
    stopControlSync = startControlSync(config.controlPollMs);
    return;
  }

  console.log(
    `[Service] Research key: ${researchKeyVars(config.variant).find((v) => process.env[v])}`
  );
  console.log(`[Service] Settings: ${describeConfig(config)}`);

  // Read the switch once before the loop starts, so a pipeline that is already
  // switched on begins working immediately instead of after the first poll.
  reportState("off");
  await syncControl();
  stopControlSync = startControlSync(config.controlPollMs);

  await runPipelineForever(config, isRunning);
}

main()
  .catch((err) => {
    // Let the host restart the container: whatever broke, the queue is
    // consistent (a claimed row is recovered by requeueStale) and retrying is
    // better than a service that quietly stops working.
    console.error("[Service] Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopControlSync?.();
    void closeDb().catch(() => {});
  });
