/**
 * The queue drain: claim a topic, run the agents, publish, record the outcome,
 * repeat.
 *
 * This is the database path — the one the cloud service runs. It produces no
 * files at all. Topics come from the `topics` table, articles go to `articles`
 * and go live, and the result of every run is written back onto the topic row
 * so /admin/topics shows what happened.
 *
 * Safe to run in more than one process: claimNextTopic() uses
 * `FOR UPDATE SKIP LOCKED`, so two workers take different topics rather than
 * both grabbing the same one.
 *
 * Nothing here throws for a bad topic. Research, writing, QA and the save are
 * each captured as an outcome on the row, and the loop moves on — one broken
 * topic must never stall a queue of nine thousand.
 */
import type { ResearchVariant } from "../run-config";
import { reportState } from "./pipeline-control";
import { publishTopic } from "./publish-topic";
import { runTopic } from "./run-topic";
import {
  claimNextTopic,
  countPending,
  finishTopic,
  releaseTopic,
  requeueStale,
  toResearchInput,
} from "./topics-queue";

/**
 * Hand back rows a crashed or redeployed run left marked `running`.
 *
 * Deliberately NOT called by drainQueue itself. A run that stopped badly can
 * leave every row `running`, and then nothing is `pending` — so a caller that
 * only drains when the queue looks non-empty would never reach the recovery and
 * would idle forever in front of a full queue. Callers run this FIRST, before
 * they decide whether there is any work.
 */
export async function recoverStaleTopics(): Promise<number> {
  const requeued = await requeueStale();
  if (requeued > 0) {
    console.log(`[Queue] Re-queued ${requeued} topic(s) left "running" by an earlier run.`);
  }
  return requeued;
}

export interface DrainOptions {
  variant: ResearchVariant;
  /** Stop after this many topics. null = drain until the queue is empty. */
  limit: number | null;
  /** Save articles as `review` instead of publishing them. */
  review: boolean;
  /**
   * Pause between topics. Spreads the load on Perplexity/Anthropic/OpenAI so a
   * long unattended drain doesn't walk into a rate limit.
   */
  delayMs: number;
  /**
   * Checked before every claim. Return false to stop cleanly — this is how a
   * shutdown signal ends the loop between topics instead of mid-article.
   */
  shouldContinue?: () => boolean;
}

export interface DrainTotals {
  /** Topics taken off the queue this pass. 0 means the queue was empty. */
  claimed: number;
  done: number;
  needsHuman: number;
  failed: number;
}

/**
 * The topic currently being worked on, or null between topics.
 *
 * A claimed row is marked `running`; if the process dies it would sit there
 * until requeueStale() picks it up 90 minutes later. The shutdown handler in
 * index.ts reads this and hands the row straight back instead.
 */
let inFlight: string | null = null;

export function activeTopicId(): string | null {
  return inFlight;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Work the queue until it is empty, the limit is reached, or shouldContinue()
 * says stop. Returns what happened, for the caller's log line.
 */
export async function drainQueue(options: DrainOptions): Promise<DrainTotals> {
  const { variant, limit, review, delayMs, shouldContinue = () => true } = options;
  const totals: DrainTotals = { claimed: 0, done: 0, needsHuman: 0, failed: 0 };

  while (shouldContinue() && (limit === null || totals.claimed < limit)) {
    const row = await claimNextTopic();
    if (!row) break; // queue empty

    inFlight = row.id;
    // Named on the admin panel, via the next heartbeat.
    reportState("working", { topic: row.topic });
    totals.claimed++;
    console.log(
      `\n── [${totals.claimed}${limit ? `/${limit}` : ""}] ${row.topic} ` +
        `(attempt ${row.attempts}) ──`
    );

    try {
      // No saveStageFile: the service writes nothing to disk.
      const result = await runTopic(toResearchInput(row), { variant });
      const outcome = await publishTopic({ result, row, variant, review });
      await finishTopic(row.id, outcome);

      totals[outcome.status === "done" ? "done" : outcome.status === "needs_human" ? "needsHuman" : "failed"]++;
      console.log(`[Queue] "${row.topic}" → ${outcome.status}`);
    } catch (err) {
      // runTopic and publishTopic both swallow their own errors, so reaching
      // here means something unexpected broke — most likely the database. Put
      // the row back rather than leaving it stuck as `running`.
      console.error(`[Queue] Unexpected failure on "${row.topic}":`, err);
      await releaseTopic(row.id).catch((e) =>
        console.error(`[Queue] Could not release "${row.topic}":`, e)
      );
      totals.failed++;
    } finally {
      inFlight = null;
      reportState("idle");
    }

    // Only pause when another topic is actually coming.
    if (delayMs > 0 && shouldContinue() && (limit === null || totals.claimed < limit)) {
      await sleep(delayMs);
    }
  }

  return totals;
}

/** How many topics are still waiting. For the opening log line of a run. */
export { countPending };
