/**
 * The pipeline runner: Research Agent → Writing Agent → QA Agent.
 *
 * TOPICS COME FROM THE DATABASE. Each run claims pending rows from the `topics`
 * table one at a time, runs all three agents, PUBLISHES the finished article
 * (`origin: "ai"`, `status: "published"` — live on the site straight away), and
 * records the outcome (QA verdict, issue count, any error) back on the topic
 * row. Add topics from /admin/topics or with `npm run topics:import`.
 *
 * The only articles NOT published are the ones QA would not stand behind — a
 * `reject` verdict, or a QA run that failed. Those are saved as drafts and
 * flagged "Needs human" at /admin/topics.
 *
 * Usage (from the worker/ folder):
 *   npm run research                  — Perplexity (sonar-pro), drain the queue
 *   npm run research:claude           — Claude (claude-sonnet-5 + web search)
 *   npm run research:gpt              — GPT (gpt-5.6-sol + web search)
 *
 *   npm run research -- --limit 5     — stop after 5 topics
 *   npm run research -- --dry-run     — run the agents, save no article
 *                                       (the queue is still updated)
 *   npm run research -- --review      — save to the review queue instead of
 *                                       publishing, for a cautious run
 *   npm run research -- --manual      — ignore the queue AND the database
 *                                       entirely; work from src/manual-topics.ts
 *                                       and write only files, as before
 *
 * All three research agents emit the identical research_bundle, so the Writing
 * and QA stages run unchanged behind any of them. Each variant keeps its own
 * output folders, run log, and master document (see src/run-config.ts) so the
 * same topic can be run through all three without one overwriting another.
 *
 * Every run also accumulates into ONE Word document, exactly as before:
 *
 *   worker/output/IsraelPedia-Runs.docx          (Perplexity)
 *   worker/output/IsraelPedia-Runs-Claude.docx   (Claude)
 *   worker/output/IsraelPedia-Runs-GPT.docx      (GPT)
 *
 * Each topic appears as: Research Agent output, then the article — shown as
 * the Writing Agent's original text with the QA Agent's edits marked on it
 * (red strikethrough = removed, green underline = added) — then the QA
 * verdict, change log, and unresolved issues. Re-running a topic REPLACES its
 * previous entry. The document is regenerated after every topic from
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
import { runResearch, type ResearchBundle, type ResearchInput } from "./agents/research";
import { runResearchClaude } from "./agents/research-claude";
import { runResearchGPT } from "./agents/research-gpt";
import { runWriting } from "./agents/writing";
import { runQA } from "./agents/qa";
import { MANUAL_TOPICS } from "./manual-topics";
import { buildCombinedDocx, RunEntry } from "./lib/docx-combined";
import { closeDb } from "./lib/db";
import { saveArticle } from "./lib/save-article";
import {
  claimNextTopic,
  countPending,
  finishTopic,
  releaseTopic,
  requeueStale,
  toResearchInput,
  type TopicOutcome,
  type TopicRow,
} from "./lib/topics-queue";
import { assertResearchKey, resolveFlags, resolveVariant, runPaths } from "./run-config";

const VARIANT = resolveVariant();
const FLAGS = resolveFlags();
const PATHS = runPaths(VARIANT);
const {
  researchDir: RESEARCH_DIR,
  articlesDir: ARTICLES_DIR,
  qaDir: QA_DIR,
  logPath: LOG_PATH,
  docPath: DOC_PATH,
} = PATHS;

/**
 * The Research Agent this run uses. All three take a ResearchInput and return
 * the same ResearchBundle, so everything downstream is identical.
 */
const RESEARCH_AGENTS = {
  perplexity: runResearch,
  claude: runResearchClaude,
  gpt: runResearchGPT,
} as const;
const runResearchAgent = RESEARCH_AGENTS[VARIANT];

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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadRunLog(): RunEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as RunEntry[]) : [];
  } catch {
    // Don't lose a corrupt log — set it aside and start fresh.
    const backup = LOG_PATH.replace(/\.json$/, `.corrupt-${timestamp()}.json`);
    fs.renameSync(LOG_PATH, backup);
    console.warn(`[Runner] runs-log.json was unreadable — moved to ${backup}`);
    return [];
  }
}

/**
 * Add a run to the log, replacing any previous run(s) of the same topic so
 * the master doc never shows the same topic twice. The raw per-stage JSONs
 * of older runs stay on disk untouched.
 */
function upsertEntry(log: RunEntry[], entry: RunEntry): void {
  const key = entry.topic.trim().toLowerCase();
  const previous = log.filter((e) => e.topic.trim().toLowerCase() === key);
  if (previous.length > 0) {
    console.log(
      `[Runner] Replacing ${previous.length} previous run(s) of "${entry.topic}" in the master doc`
    );
    for (const old of previous) {
      log.splice(log.indexOf(old), 1);
    }
  }
  log.push(entry);
}

async function saveLogAndRebuildDoc(log: RunEntry[]): Promise<void> {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), "utf8");
  try {
    fs.writeFileSync(DOC_PATH, await buildCombinedDocx(log));
    console.log(`[Runner] Master document updated: ${DOC_PATH}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EPERM") {
      console.error(
        `[Runner] Could not write ${DOC_PATH} — the file is probably open in Word. ` +
          `Close it and re-run; the run data is safe in ${LOG_PATH}.`
      );
    } else {
      throw err;
    }
  }
}

interface RunTotals {
  written: number;
  needsHuman: number;
  failed: number;
  saved: number;
  qaVerdicts: Record<string, number>;
}

/**
 * One topic, all the way through: research → writing → QA → files → database.
 *
 * Always returns an outcome to record on the queue row (callers ignore it in
 * --manual mode). Never throws for an agent failure — a bad topic must not stop
 * the rest of the queue.
 */
async function processTopic(
  input: ResearchInput,
  row: TopicRow | null,
  log: RunEntry[],
  totals: RunTotals
): Promise<TopicOutcome> {
  const base = `${slugify(input.topic)}-${timestamp()}`;

  // ── Stage 1: Research ─────────────────────────────────────────────────────
  let bundle: ResearchBundle;
  try {
    bundle = await runResearchAgent(input);
    const jsonPath = path.join(RESEARCH_DIR, `${base}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(bundle, null, 2), "utf8");
    console.log(`[Runner] Research bundle saved: ${jsonPath}`);
  } catch (err) {
    console.error(`[Runner] Research FAILED for "${input.topic}":`, err, "\n");
    totals.failed++;
    return {
      status: "failed",
      researchVariant: VARIANT,
      lastError: `Research Agent failed: ${errorText(err)}`,
    };
  }

  const entry: RunEntry = {
    run_at: new Date().toISOString(),
    topic: input.topic,
    // Use the category the Research Agent resolved (the input's is optional now).
    category: bundle.category,
    bundle,
    article: null,
  };

  // ── Gate: reject unwritable bundles before the Writing Agent ─────────────
  if (bundle.status === "needs_human_research") {
    console.log(
      `[Runner] "${input.topic}" NEEDS HUMAN RESEARCH — no usable material in approved sources. Skipping Writing Agent.\n`
    );
    entry.note =
      "NEEDS HUMAN RESEARCH — no usable material found in approved sources; Writing Agent skipped.";
    totals.needsHuman++;
    upsertEntry(log, entry);
    await saveLogAndRebuildDoc(log);
    return {
      status: "needs_human",
      researchVariant: VARIANT,
      note: "No usable material found in approved sources; the Writing Agent was skipped.",
    };
  }

  // ── Stage 2: Writing ──────────────────────────────────────────────────────
  try {
    const article = await runWriting(bundle);
    const jsonPath = path.join(ARTICLES_DIR, `${base}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(article, null, 2), "utf8");
    console.log(`[Runner] Article saved: ${jsonPath}`);
    entry.article = article;
    totals.written++;
  } catch (err) {
    console.error(`[Runner] Writing FAILED for "${input.topic}":`, err, "\n");
    entry.note = `Writing Agent FAILED: ${errorText(err)}`;
    totals.failed++;
    upsertEntry(log, entry);
    await saveLogAndRebuildDoc(log);
    return {
      status: "failed",
      researchVariant: VARIANT,
      lastError: `Writing Agent failed: ${errorText(err)}`,
    };
  }

  // ── Stage 3: QA ───────────────────────────────────────────────────────────
  let qaError: string | null = null;
  try {
    const report = await runQA({ article: entry.article, research_bundle: bundle });
    const jsonPath = path.join(QA_DIR, `${base}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[Runner] QA report saved: ${jsonPath}\n`);
    entry.qa = report;
    totals.qaVerdicts[report.verdict] = (totals.qaVerdicts[report.verdict] ?? 0) + 1;
  } catch (err) {
    console.error(`[Runner] QA FAILED for "${input.topic}":`, err, "\n");
    entry.qa = null;
    qaError = errorText(err);
    entry.qa_note = `QA Agent FAILED: ${qaError} — the article above is UNREVIEWED.`;
    totals.failed++;
  }

  upsertEntry(log, entry);
  await saveLogAndRebuildDoc(log);

  // ── Stage 4: Save to the database ─────────────────────────────────────────
  const qa = entry.qa ?? null;
  // QA's corrected article is the one worth keeping; fall back to the original
  // when QA rejected it or never ran.
  const finalArticle = qa?.edited_article ?? entry.article;
  const rejected = qa?.verdict === "reject";

  /**
   * Where the article lands.
   *
   * AI articles go LIVE immediately — no human review step. The two exceptions
   * are articles the QA Agent itself would not stand behind: a `reject`
   * verdict, or a QA run that crashed and therefore checked nothing. Those are
   * saved as drafts (invisible to readers) and the topic is marked
   * `needs_human`, so they show up under "Needs human" at /admin/topics.
   *
   * `--review` holds an entire run back in the review queue instead.
   */
  const articleStatus: "published" | "review" | "draft" = rejected || qaError
    ? "draft"
    : FLAGS.review
      ? "review"
      : "published";

  const outcome: TopicOutcome = {
    status: rejected || qaError ? "needs_human" : "done",
    researchVariant: VARIANT,
    qaVerdict: qa?.verdict ?? null,
    qaConfidence: qa?.confidence ?? null,
    qaIssueCount: qa?.issues?.length ?? null,
    qaSummary: qa?.summary ?? null,
    lastError: qaError ? `QA Agent failed: ${qaError}` : null,
  };

  if (!row || FLAGS.dryRun) {
    if (FLAGS.dryRun) console.log(`[Runner] --dry-run: not saving "${input.topic}" to the database.`);
    outcome.note = FLAGS.dryRun ? "Dry run — the article was not saved to the database." : null;
    return outcome;
  }

  try {
    const saved = await saveArticle({
      article: finalArticle,
      status: articleStatus,
      existingArticleId: row.articleId,
      editorNote:
        `AI pipeline — research (${VARIANT}) → writing → QA` +
        (qa ? ` (verdict: ${qa.verdict})` : qaError ? " (QA FAILED — unreviewed)" : ""),
    });
    outcome.articleId = saved.articleId;
    totals.saved++;

    for (const warning of saved.warnings) console.warn(`[Runner]   note: ${warning}`);
    console.log(
      `[Runner] ${saved.created ? "Created" : "Updated"} article "${saved.slug}" ` +
        `(${saved.referenceCount} references, status: ${articleStatus})` +
        (articleStatus === "published" ? `  → live at /article/${saved.slug}` : "")
    );
    if (rejected) {
      outcome.note = "QA rejected this article — saved as a draft, NOT published.";
    } else if (qaError) {
      outcome.note = "QA did not run — saved as an unchecked draft, NOT published.";
    } else if (saved.warnings.length > 0) {
      outcome.note = saved.warnings.join(" ");
    }
  } catch (err) {
    console.error(`[Runner] Saving "${input.topic}" to the database FAILED:`, err, "\n");
    totals.failed++;
    outcome.status = "failed";
    outcome.lastError = `Database save failed: ${errorText(err)}`;
  }

  return outcome;
}

async function main(): Promise<void> {
  // The selected research agent's own key (see run-config.ts — the Claude and
  // GPT research agents read their dedicated *_RESEARCH keys).
  assertResearchKey(VARIANT, PATHS.label);
  // Always needed regardless of the research variant: the Writing Agent runs on
  // Anthropic and the QA Agent on OpenAI, both on the shared keys.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set (needed for the Writing Agent). Add it to worker/.env and retry."
    );
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set (needed for the QA Agent). Add it to worker/.env and retry.");
    process.exit(1);
  }

  fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  fs.mkdirSync(QA_DIR, { recursive: true });

  const log = loadRunLog();
  const totals: RunTotals = { written: 0, needsHuman: 0, failed: 0, saved: 0, qaVerdicts: {} };

  console.log(`Research Agent: ${PATHS.label}`);
  if (FLAGS.dryRun) console.log("Dry run: articles will NOT be saved to the database.");

  if (FLAGS.manual) {
    // ── Manual mode: the original file-only behaviour, no database at all ────
    if (MANUAL_TOPICS.length === 0) {
      console.log("No topics in src/manual-topics.ts — nothing to do.");
      return;
    }
    console.log(
      `Manual mode — processing ${MANUAL_TOPICS.length} topic(s) from src/manual-topics.ts. ` +
        `Nothing will be written to the database.`
    );
    console.log(`Master doc has ${log.length} previous run(s)\n`);
    for (const input of MANUAL_TOPICS) {
      await processTopic(input, null, log, totals);
    }
  } else {
    // ── Queue mode: topics come from the database ───────────────────────────
    const requeued = await requeueStale();
    if (requeued > 0) {
      console.log(`[Runner] Re-queued ${requeued} topic(s) left "running" by an earlier run.`);
    }

    const pending = await countPending();
    if (pending === 0) {
      console.log(
        "No pending topics in the queue. Add some at /admin/topics or with " +
          "`npm run topics:import <file>` — or run with --manual to use src/manual-topics.ts."
      );
      return;
    }
    console.log(
      `Queue mode — ${pending} pending topic(s)` +
        (FLAGS.limit ? `, processing up to ${FLAGS.limit}` : ", processing all") +
        `. Master doc has ${log.length} previous run(s)\n`
    );

    let processed = 0;
    while (FLAGS.limit === null || processed < FLAGS.limit) {
      const row = await claimNextTopic();
      if (!row) break;

      // If the process dies mid-topic, hand the row back instead of leaving it
      // stuck as "running" (requeueStale would otherwise wait 90 minutes).
      const release = () => {
        void releaseTopic(row.id).finally(() => process.exit(130));
      };
      process.once("SIGINT", release);

      console.log(`\n── [${processed + 1}${FLAGS.limit ? `/${FLAGS.limit}` : ""}] ${row.topic} ──`);
      const outcome = await processTopic(toResearchInput(row), row, log, totals);
      await finishTopic(row.id, outcome);
      console.log(`[Runner] Topic "${row.topic}" → ${outcome.status}`);

      process.off("SIGINT", release);
      processed++;
    }
  }

  const verdictSummary = Object.entries(totals.qaVerdicts)
    .map(([verdict, count]) => `${count} ${verdict}`)
    .join(", ");
  console.log(
    `\nDone. ${totals.written} article(s) written, ${totals.needsHuman} need(s) human research, ` +
      `${totals.failed} failed.` + (verdictSummary ? ` QA verdicts: ${verdictSummary}.` : "")
  );
  if (!FLAGS.manual) {
    const held = FLAGS.review ? "held in the review queue" : "published";
    console.log(
      `${totals.saved} article(s) saved to the database` +
        (totals.saved > 0 ? ` (${held}).` : ".") +
        (totals.needsHuman > 0
          ? ` ${totals.needsHuman} need(s) a human — see "Needs human" at /admin/topics.`
          : "")
    );
  }
  console.log(`Review everything in: ${DOC_PATH}`);
  if (totals.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
