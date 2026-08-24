/**
 * Publish an article from a QA report that has already been produced.
 *
 * For runs that happened before the pipeline was wired to the database: the
 * agents already did their work and the result is sitting in
 * worker/output/qa/<topic>-<timestamp>.json. This takes the `edited_article`
 * out of one of those reports and saves it exactly as a live pipeline run
 * would — same rendering, same slug rules, same references.
 *
 * No agent runs, so this costs nothing.
 *
 * Usage (from the worker/ folder):
 *   npm run publish:qa -- output/qa/safed-tzfat-2026-07-27T19-42-34.json
 *   npm run publish:qa -- output/qa/a.json output/qa/b.json     (several at once)
 *   npm run publish:qa -- output/qa/a.json --review             (hold for review)
 *   npm run publish:qa -- output/qa/a.json --dry-run            (render only, no writes)
 *
 * A report QA rejected has `edited_article: null` — there is no article in it,
 * and those files are skipped with a warning rather than failing the batch.
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { eq, sql } from "drizzle-orm";
import { topics } from "../../db/schema";
import type { QAReport } from "./agents/qa";
import { closeDb, getDb } from "./lib/db";
import { saveArticle } from "./lib/save-article";
import { renderArticle } from "./lib/to-markdown";

interface Options {
  files: string[];
  review: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const files: string[] = [];
  let review = false;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--review") review = true;
    else if (arg === "--dry-run") dryRun = true;
    else files.push(arg);
  }

  if (files.length === 0) {
    console.error(
      "Usage: npm run publish:qa -- <qa-report.json> [more.json ...] [--review] [--dry-run]"
    );
    process.exit(1);
  }
  return { files, review, dryRun };
}

/**
 * The queue row this article belongs to, matched on title (case-insensitive).
 *
 * Worth doing: these topics are also sitting in the queue as `pending`, so
 * without this a later pipeline run would research and publish them a second
 * time. Returns null when nothing matches — the article is still saved, and the
 * caller warns so it can be sorted out by hand.
 */
async function findTopicRow(title: string) {
  const [row] = await getDb()
    .select({ id: topics.id, topic: topics.topic, articleId: topics.articleId })
    .from(topics)
    .where(sql`lower(${topics.topic}) = lower(${title})`)
    .limit(1);
  return row ?? null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const status = options.review ? "review" : "published";

  console.log(
    `Publishing ${options.files.length} article(s) from existing QA reports as "${status}".` +
      (options.dryRun ? "  (--dry-run: nothing will be written)" : "")
  );
  console.log("No agents run — this costs nothing.\n");

  let published = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of options.files) {
    const filePath = path.resolve(process.cwd(), file);
    const label = path.basename(filePath);

    if (!fs.existsSync(filePath)) {
      console.error(`[skip] ${label} — file not found`);
      failed++;
      continue;
    }

    let report: QAReport;
    try {
      report = JSON.parse(fs.readFileSync(filePath, "utf8")) as QAReport;
    } catch (err) {
      console.error(`[skip] ${label} — not readable JSON: ${(err as Error).message}`);
      failed++;
      continue;
    }

    const article = report.edited_article;
    if (!article) {
      console.warn(
        `[skip] ${label} — QA verdict "${report.verdict}", no edited_article in this report. ` +
          `Nothing to publish.`
      );
      skipped++;
      continue;
    }

    // Render first, so a bad article is caught before anything is written.
    const rendered = renderArticle(article);
    console.log(
      `${article.title}  —  QA ${report.verdict} (${report.confidence}), ` +
        `${article.sections.length} sections, ${rendered.references.length} references, ` +
        `${rendered.body.length} chars`
    );
    for (const warning of rendered.warnings) console.warn(`    note: ${warning}`);

    if (options.dryRun) {
      console.log(`    (dry run — not saved)\n`);
      continue;
    }

    try {
      const row = await findTopicRow(article.title);

      const saved = await saveArticle({
        article,
        status,
        // Re-running this script updates the article it made last time rather
        // than creating "<slug>-2".
        existingArticleId: row?.articleId ?? null,
        editorNote: `Published from an existing QA report (${label}, verdict: ${report.verdict})`,
      });

      console.log(
        `    ${saved.created ? "created" : "updated"} /article/${saved.slug} ` +
          `(${saved.referenceCount} references, ${status})`
      );

      if (row) {
        await getDb()
          .update(topics)
          .set({
            status: "done",
            articleId: saved.articleId,
            qaVerdict: report.verdict,
            qaConfidence: report.confidence,
            qaIssueCount: report.issues?.length ?? 0,
            qaSummary: report.summary,
            note: `Published from an existing QA report (${label}) — the agents were not re-run.`,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(topics.id, row.id));
        console.log(`    queue: "${row.topic}" marked done`);
      } else {
        console.warn(
          `    queue: no topic row matches "${article.title}" — if a differently ` +
            `named row covers this subject, mark it Skipped at /admin/topics so the ` +
            `pipeline doesn't write it again.`
        );
      }

      published++;
    } catch (err) {
      console.error(`    FAILED to save: ${(err as Error).message}`);
      failed++;
    }
    console.log();
  }

  console.log(
    `Done. ${published} published, ${skipped} skipped (no article in the report), ${failed} failed.`
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
