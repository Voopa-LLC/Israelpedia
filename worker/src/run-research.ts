/**
 * The local CLI: run the agents and review them in Word.
 *
 * THIS DOES NOT PUBLISH. A local run reads topics, runs Research → Writing →
 * QA, and writes the result to the combined review document and the per-stage
 * JSON files. Nothing reaches the site, the `articles` table, or the topic
 * queue — topics are read without being claimed, so the automated pipeline
 * still has them.
 *
 * That is the split: the always-on service (src/index.ts) publishes, and this
 * is how the agents get checked without touching anything readers can see.
 *
 * Usage (from the worker/ folder):
 *   npm run research                  — 1 pending topic, straight to the .docx
 *   npm run research -- --limit 5     — five of them
 *   npm run research -- --manual      — topics from src/manual-topics.ts instead
 *   npm run research:claude           — Claude (claude-sonnet-5 + web search)
 *   npm run research:gpt              — GPT (gpt-5.6-sol + web search)
 *
 *   npm run research -- --publish     — the DATABASE path instead: claim topics
 *                                       off the queue, publish the articles,
 *                                       update the topic rows. No .docx. This
 *                                       is what the cloud service does, run by
 *                                       hand. It goes LIVE on the site.
 *   npm run research -- --publish --review
 *                                     — same, but hold the articles in the
 *                                       admin review queue instead
 *
 * All three research agents emit the identical research_bundle, so the Writing
 * and QA stages run unchanged behind any of them. Each variant keeps its own
 * output folders, run log, and document (see src/run-config.ts) so the same
 * topic can be run through all three without one overwriting another.
 *
 *   worker/output/IsraelPedia-Runs.docx          (Perplexity)
 *   worker/output/IsraelPedia-Runs-Claude.docx   (Claude)
 *   worker/output/IsraelPedia-Runs-GPT.docx      (GPT)
 *
 * Each topic appears as: Research Agent output, then the article — the Writing
 * Agent's original text with the QA Agent's edits marked on it (red
 * strikethrough = removed, green underline = added) — then the QA verdict,
 * change log, and unresolved issues. Re-running a topic REPLACES its previous
 * entry. The document is regenerated after every topic from
 * worker/output/runs-log.json — do not edit the .docx by hand.
 *
 * Raw structured data is still saved per stage:
 *   worker/output/research/<topic-slug>-<timestamp>.json
 *   worker/output/articles/<topic-slug>-<timestamp>.json
 *   worker/output/qa/<topic-slug>-<timestamp>.json
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import type { ResearchInput } from "./agents/research";
import { MANUAL_TOPICS } from "./manual-topics";
import { closeDb } from "./lib/db";
import { countPending, drainQueue, recoverStaleTopics } from "./lib/drain-queue";
import { entryFromResult, loadRunLog, saveLogAndRebuildDoc, upsertEntry } from "./lib/run-log";
import { runTopic, type Stage } from "./lib/run-topic";
import { peekPendingTopics, toResearchInput } from "./lib/topics-queue";
import { assertResearchKey, resolveFlags, resolveVariant, runPaths } from "./run-config";

const VARIANT = resolveVariant();
const FLAGS = resolveFlags();
const PATHS = runPaths(VARIANT);

/** How many topics a review run takes when --limit isn't given. */
const DEFAULT_REVIEW_LIMIT = 1;

/** Where each stage's raw JSON goes. */
const STAGE_DIRS: Record<Stage, string> = {
  research: PATHS.researchDir,
  article: PATHS.articlesDir,
  qa: PATHS.qaDir,
};

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "topic"
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Check the keys for every agent this run will use, and exit if any is missing. */
function assertKeys(): void {
  assertResearchKey(VARIANT, PATHS.label);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set (needed for the Writing Agent). Add it to worker/.env and retry."
    );
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY is not set (needed for the QA Agent). Add it to worker/.env and retry."
    );
    process.exit(1);
  }
}

/**
 * The database path, run by hand.
 *
 * Identical to what the cloud service does — same claim, same publish, same
 * write-back — so this is also how you verify the service will behave before
 * turning it on.
 */
async function runPublish(): Promise<void> {
  await recoverStaleTopics();

  const pending = await countPending();
  if (pending === 0) {
    console.log(
      "No pending topics in the queue. Add some at /admin/topics or with " +
        "`npm run topics:import <file>`."
    );
    return;
  }

  console.log(
    `PUBLISHING — ${pending} topic(s) pending, processing ` +
      (FLAGS.limit ? `up to ${FLAGS.limit}` : "ALL of them") +
      `. Articles go ${FLAGS.review ? "into the review queue" : "LIVE on the site"}.\n`
  );

  const totals = await drainQueue({
    variant: VARIANT,
    limit: FLAGS.limit,
    review: FLAGS.review,
    // A hand-run drain is watched; no need to pace it the way the service does.
    delayMs: 0,
  });

  console.log(
    `\nDone. ${totals.claimed} topic(s) processed — ${totals.done} done, ` +
      `${totals.needsHuman} need a human, ${totals.failed} failed.`
  );
  if (totals.needsHuman > 0) {
    console.log(`See "Needs human" at /admin/topics.`);
  }
  if (totals.failed > 0) process.exitCode = 1;
}

/** Read the topics for a review run WITHOUT claiming them. */
async function reviewTopics(limit: number): Promise<ResearchInput[]> {
  if (FLAGS.manual) {
    if (MANUAL_TOPICS.length === 0) {
      console.log("No topics in src/manual-topics.ts — nothing to do.");
      return [];
    }
    console.log(`Manual mode — ${MANUAL_TOPICS.length} topic(s) from src/manual-topics.ts.`);
    return MANUAL_TOPICS;
  }

  const rows = await peekPendingTopics(limit);
  if (rows.length === 0) {
    console.log(
      "No pending topics in the queue. Add some at /admin/topics, or use --manual " +
        "to work from src/manual-topics.ts."
    );
    return [];
  }
  console.log(
    `Reading ${rows.length} pending topic(s) from the queue — they are NOT claimed, ` +
      `so the pipeline still has them.`
  );
  return rows.map(toResearchInput);
}

/** The review path: agents in, .docx out, nothing written to the database. */
async function runReview(): Promise<void> {
  const limit = FLAGS.limit ?? DEFAULT_REVIEW_LIMIT;
  const inputs = await reviewTopics(limit);
  if (inputs.length === 0) return;

  for (const dir of Object.values(STAGE_DIRS)) fs.mkdirSync(dir, { recursive: true });

  const log = loadRunLog(PATHS.logPath);
  console.log(
    `Nothing will be written to the database. The document has ${log.length} previous run(s).\n`
  );

  let written = 0;
  let needsHuman = 0;
  let failed = 0;
  const verdicts: Record<string, number> = {};

  for (const [i, input] of inputs.entries()) {
    console.log(`\n── [${i + 1}/${inputs.length}] ${input.topic} ──`);
    const base = `${slugify(input.topic)}-${timestamp()}`;

    const result = await runTopic(input, {
      variant: VARIANT,
      saveStageFile: (stage, data) => {
        const file = path.join(STAGE_DIRS[stage], `${base}.json`);
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
        console.log(`[Runner] ${stage} saved: ${file}`);
      },
    });

    if (result.researchError) failed++;
    if (result.needsHumanResearch) needsHuman++;
    if (result.writingError || result.qaError) failed++;
    if (result.article) written++;
    if (result.qa) verdicts[result.qa.verdict] = (verdicts[result.qa.verdict] ?? 0) + 1;

    const entry = entryFromResult(input.topic, result);
    if (entry) {
      upsertEntry(log, entry);
      await saveLogAndRebuildDoc(log, PATHS.logPath, PATHS.docPath);
    }
  }

  const verdictSummary = Object.entries(verdicts)
    .map(([verdict, count]) => `${count} ${verdict}`)
    .join(", ");
  console.log(
    `\nDone. ${written} article(s) written, ${needsHuman} need(s) human research, ` +
      `${failed} failed.` + (verdictSummary ? ` QA verdicts: ${verdictSummary}.` : "")
  );
  console.log(`Nothing was published. Review everything in: ${PATHS.docPath}`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  assertKeys();
  console.log(`Research Agent: ${PATHS.label}`);

  // --dry-run used to mean "run the agents but don't save the article", while
  // still consuming the queue. The review path below is that, and better: it
  // doesn't claim the topics either. So the flag now just cancels --publish.
  if (FLAGS.dryRun && FLAGS.publish) {
    console.log("--dry-run overrides --publish: this run writes to the document, not the site.\n");
  }

  if (FLAGS.publish && !FLAGS.dryRun) {
    if (FLAGS.manual) {
      console.error("--publish and --manual are incompatible: src/manual-topics.ts has no queue rows to update.");
      process.exit(1);
    }
    await runPublish();
    return;
  }

  await runReview();
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
