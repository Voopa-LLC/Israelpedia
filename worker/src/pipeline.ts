/**
 * The always-on pipeline.
 *
 * This is what runs in the cloud. It works the `topics` queue continuously —
 * claim a topic, run Research → Writing → QA, publish the article, record the
 * outcome on the row, take the next one — and when the queue runs dry it waits
 * and checks again. It does not run on a schedule; there is nothing to schedule
 * when the work is simply "whatever is still pending".
 *
 * THE SWITCH. The loop runs whenever the process is up, but only *claims* work
 * while the pipeline is switched on in the database. Off, it sits here polling
 * rather than exiting — a stopped pipeline has to be able to start again on its
 * own, without a redeploy, the moment an admin presses Start at /admin/topics.
 *
 * It writes ONLY to the database. No Word document, no JSON on disk: a
 * container's filesystem is wiped on every redeploy, and everything worth
 * keeping already lives in Postgres — the article, its references, the QA
 * report, and the topic row. The review document is a local tool; see
 * src/run-research.ts.
 *
 * Nothing needs to be told to refresh the site. Every route in the Next.js app
 * renders dynamically, so a published article, the updated topic queue at
 * /admin/topics, and the QA report at /admin/qa/<slug> are all visible on the
 * next request.
 *
 * Stopping never abandons an article. Both the shutdown signal and the Stop
 * button are checked *between* topics, so a topic already in flight is finished
 * and published first — aborting it would throw away the research already paid
 * for.
 */
import { countPending, drainQueue, recoverStaleTopics } from "./lib/drain-queue";
import { pipelineEnabled, reportState } from "./lib/pipeline-control";
import { describeConfig, type ServiceConfig } from "./lib/service-config";

/**
 * Wait, but stay responsive to shutdown.
 *
 * A plain sleep of the full poll interval would leave a redeploy hanging for up
 * to a minute before the process noticed it should stop, and the host would
 * eventually kill it instead. Waking once a second costs nothing.
 */
async function idle(ms: number, isRunning: () => boolean): Promise<void> {
  const until = Date.now() + ms;
  while (isRunning() && Date.now() < until) {
    await new Promise<void>((r) => setTimeout(r, Math.min(1_000, until - Date.now())));
  }
}

export async function runPipelineForever(
  config: ServiceConfig,
  isRunning: () => boolean
): Promise<void> {
  console.log(`[Service] Worker ready. ${describeConfig(config)}`);

  let processed = 0;
  /** So each waiting state is logged once, not on every poll. */
  let announced: "off" | "empty" | null = null;

  while (isRunning()) {
    // ── The switch ────────────────────────────────────────────────────────────
    // Read from a cache that lib/pipeline-control.ts refreshes on a timer, so
    // this is a boolean check rather than a query per lap.
    if (!pipelineEnabled()) {
      if (announced !== "off") {
        console.log("[Service] Pipeline is OFF. Waiting — press Start at /admin/topics.");
        announced = "off";
      }
      reportState("off");
      await idle(config.controlPollMs, isRunning);
      continue;
    }

    // ── The safety cap ────────────────────────────────────────────────────────
    // Reached, the service idles instead of exiting: exiting would have the host
    // restart it, and the cap would be applied again from zero — draining the
    // whole queue in batches, which is the opposite of what a cap is for.
    const remaining = config.maxTopics === null ? null : config.maxTopics - processed;
    if (remaining !== null && remaining <= 0) {
      console.log(
        `[Service] PIPELINE_MAX_TOPICS (${config.maxTopics}) reached after ${processed} topic(s). ` +
          `Idling — raise it or remove it to continue.`
      );
      reportState("idle", {
        note: `Stopped after ${processed} topic(s): PIPELINE_MAX_TOPICS is ${config.maxTopics}.`,
      });
      while (isRunning()) await idle(60_000, isRunning);
      return;
    }

    // Before counting, not after: a redeploy mid-article leaves a row `running`,
    // and a queue whose every row is `running` has nothing `pending` to find.
    await recoverStaleTopics();

    const pending = await countPending();
    if (pending === 0) {
      if (announced !== "empty") {
        console.log(
          `[Service] No pending topics. Waiting — new ones added at /admin/topics ` +
            `are picked up within ${Math.round(config.idlePollMs / 1000)}s.`
        );
        announced = "empty";
      }
      reportState("idle", { note: "The queue has no pending topics." });
      await idle(config.idlePollMs, isRunning);
      continue;
    }

    announced = null;
    console.log(
      `[Service] ${pending} topic(s) pending` +
        (remaining !== null ? `, ${remaining} left under the cap` : "") +
        "."
    );

    const totals = await drainQueue({
      variant: config.variant,
      limit: remaining,
      review: config.review,
      delayMs: config.delayMs,
      // Both conditions, so Stop ends the drain at the next topic boundary
      // exactly like a shutdown signal does.
      shouldContinue: () => isRunning() && pipelineEnabled(),
    });
    processed += totals.claimed;

    console.log(
      `[Service] Pass complete: ${totals.claimed} claimed — ` +
        `${totals.done} done, ${totals.needsHuman} need a human, ${totals.failed} failed. ` +
        `${processed} topic(s) this boot.`
    );

    // A pass that claimed nothing while topics were pending means every
    // remaining row is locked by another worker, or the claim is failing. Wait
    // before trying again rather than spinning on the database.
    if (totals.claimed === 0) await idle(config.idlePollMs, isRunning);
  }

  console.log(`[Service] Stopped after ${processed} topic(s) this boot.`);
}
