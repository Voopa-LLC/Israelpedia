/**
 * Re-run ONLY the QA Agent on a topic that already went through Research and
 * Writing — useful when QA failed (e.g. a network reset) but the article is
 * fine, so there's no need to pay for Research + Writing again.
 *
 * Usage (from the worker/ folder):
 *   npm run qa -- <topic-or-slug>          (Perplexity run log)
 *   npm run qa:claude -- <topic-or-slug>   (Claude run log)
 *   npm run qa:gpt -- <topic-or-slug>      (GPT run log)
 *   e.g.  npm run qa -- Hebron
 *
 * The research variants keep separate run logs, so the flag picks which log the
 * topic is looked up in (see src/run-config.ts).
 *
 * It finds the topic's existing entry in runs-log.json (which already holds the
 * research bundle and the written article), runs the QA Agent on it, saves the
 * QA report to output/qa/, attaches it to that entry, and regenerates
 * IsraelPedia-Runs.docx. Nothing is written to the database.
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { runQA } from "./agents/qa";
import { buildCombinedDocx, RunEntry } from "./lib/docx-combined";
import { resolveVariant, runPaths, stripFlags } from "./run-config";

const PATHS = runPaths(resolveVariant());
const {
  qaDir: QA_DIR,
  logPath: LOG_PATH,
  docPath: DOC_PATH,
  articlesDir: ARTICLES_DIR,
  researchDir: RESEARCH_DIR,
} = PATHS;

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

function loadRunLog(): RunEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  return Array.isArray(parsed) ? (parsed as RunEntry[]) : [];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Newest `<slug>-<timestamp>.json` in a stage folder, or null. */
function newestStageFile(dir: string, slug: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const match = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${slug}-`) && f.endsWith(".json"))
    .sort()
    .pop();
  return match ? path.join(dir, match) : null;
}

/** The run time encoded in a stage filename, as epoch ms (0 if unparseable). */
function fileRunTime(file: string): number {
  const m = path
    .basename(file, ".json")
    .match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  const parsed = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Rebuild a run entry from the per-stage JSON files on disk.
 *
 * The pipeline writes the log only AFTER QA finishes, so a run killed during
 * QA — a machine sleeping mid-run, a dropped connection — leaves the research
 * bundle and the article saved but no log entry at all. Without this, QA-only
 * would silently fall back to whatever older run the log still holds and
 * review the wrong article.
 *
 * All three stages share one `<slug>-<timestamp>` base, so the bundle that
 * actually produced this article is found by name rather than guessed.
 */
function entryFromDisk(slug: string, topic: string): RunEntry | null {
  const articleFile = newestStageFile(ARTICLES_DIR, slug);
  if (!articleFile) return null;

  const article = readJson<RunEntry["article"]>(articleFile);
  if (!article) return null;

  const paired = path.join(RESEARCH_DIR, path.basename(articleFile));
  const bundleFile = fs.existsSync(paired) ? paired : newestStageFile(RESEARCH_DIR, slug);
  const bundle = bundleFile ? readJson<RunEntry["bundle"]>(bundleFile) : null;
  if (!bundle) {
    console.error(
      `Found the article ${path.basename(articleFile)} but no research bundle to QA it against ` +
        `(looked in ${RESEARCH_DIR}). QA needs both.`
    );
    return null;
  }

  console.log(
    `[QA-only] Using the article saved on disk: ${path.basename(articleFile)} ` +
      `(paired bundle: ${path.basename(bundleFile!)})`
  );
  return {
    run_at: new Date(fileRunTime(articleFile) || Date.now()).toISOString(),
    topic,
    category: bundle.category,
    bundle,
    article,
  };
}

/** Add an entry, replacing any previous run(s) of the same topic. */
function upsertEntry(log: RunEntry[], entry: RunEntry): void {
  const key = slugify(entry.topic);
  for (let i = log.length - 1; i >= 0; i--) {
    if (slugify(log[i].topic) === key) log.splice(i, 1);
  }
  log.push(entry);
}

async function rebuildDoc(log: RunEntry[]): Promise<void> {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), "utf8");
  try {
    fs.writeFileSync(DOC_PATH, await buildCombinedDocx(log));
    console.log(`[QA-only] Master document updated: ${DOC_PATH}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EPERM") {
      console.error(
        `[QA-only] Could not write ${DOC_PATH} — it's probably open in Word. ` +
          `Close it and re-run; the run data is safe in ${LOG_PATH}.`
      );
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Add it to worker/.env and retry.");
    process.exit(1);
  }

  // Variant flags are consumed by run-config; the rest is the topic query.
  const query = stripFlags().join(" ").trim();
  if (!query) {
    console.error("Usage: npm run qa -- <topic-or-slug>   (e.g. npm run qa -- Hebron)");
    process.exit(1);
  }
  console.log(`[QA-only] Run log: ${PATHS.label}`);
  const wantedSlug = slugify(query);

  const log = loadRunLog();
  const logged = log.find((e) => slugify(e.topic) === wantedSlug);

  // Prefer whichever article is NEWEST. A run killed during QA leaves a fresh
  // article on disk while the log still holds an older, fully-QA'd run of the
  // same topic — reviewing that stale one would be silently wrong.
  const newestArticleFile = newestStageFile(ARTICLES_DIR, wantedSlug);
  const diskIsNewer =
    !!newestArticleFile &&
    fileRunTime(newestArticleFile) > (logged ? Date.parse(logged.run_at) : 0);

  let entry = logged;
  if (diskIsNewer) {
    const fromDisk = entryFromDisk(wantedSlug, logged?.topic ?? query);
    if (fromDisk) {
      if (logged) {
        console.log(
          `[QA-only] The log's newest "${logged.topic}" run is from ` +
            `${logged.run_at.slice(0, 10)}; the article on disk is newer, so that is the one being reviewed.`
        );
      }
      upsertEntry(log, fromDisk);
      entry = fromDisk;
    }
  }

  if (!entry) {
    console.error(
      `No entry for "${query}" in ${LOG_PATH}, and no article on disk in ${ARTICLES_DIR}. ` +
        `Available topics in the log: ` +
        (log.map((e) => e.topic).join(", ") || "(none)")
    );
    process.exit(1);
  }
  if (!entry.article) {
    console.error(
      `"${entry.topic}" has no written article in the log (bundle status was likely needs_human_research) — nothing for QA to review.`
    );
    process.exit(1);
  }

  console.log(`[QA-only] Re-running QA for "${entry.topic}"…\n`);

  try {
    const report = await runQA({ article: entry.article, research_bundle: entry.bundle });
    const jsonPath = path.join(QA_DIR, `${slugify(entry.topic)}-${timestamp()}.json`);
    fs.mkdirSync(QA_DIR, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`[QA-only] QA report saved: ${jsonPath}`);

    entry.qa = report;
    delete entry.qa_note; // clear the previous failure note
    await rebuildDoc(log);

    console.log(
      `\nDone. Verdict: ${report.verdict}` +
        (report.reject_target ? ` → ${report.reject_target}` : "") +
        ` — ${report.changes.length} change(s), ${report.issues.length} unresolved issue(s).`
    );
    console.log(`Review it in: ${DOC_PATH}`);
  } catch (err) {
    console.error(`[QA-only] QA FAILED for "${entry.topic}":`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
