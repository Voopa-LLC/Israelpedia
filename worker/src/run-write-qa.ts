/**
 * Writing + QA from research that ALREADY ran — no new research calls.
 *
 * Picks up bundles the research-only runner produced and finishes the pipeline
 * on them, so you never pay for research twice.
 *
 * Usage (from the worker/ folder):
 *   npm run write:gpt                        — every topic in the GPT research log
 *   npm run write:gpt -- "Tel Aviv, Hamas"   — only these (comma-separated)
 *   npm run write:gpt -- --dry-run           — show what would run, call nothing
 *   npm run write            (Perplexity)
 *   npm run write:claude     (Claude)
 *
 * Where bundles come from, in order:
 *   1. the variant's research-only log (output/research-only-log-gpt.json …)
 *   2. failing that, the newest matching JSON in the variant's research folder
 *      (output/research-gpt/<topic-slug>-<timestamp>.json)
 *
 * Results land in the SAME place a full `npm run research:gpt` would put them —
 * output/articles-gpt/, output/qa-gpt/, runs-log-gpt.json, and
 * IsraelPedia-Runs-GPT.docx — so the master document reads identically either
 * way. Re-running a topic replaces its previous entry.
 *
 * Only the Writing and QA keys are needed (ANTHROPIC_API_KEY, OPENAI_API_KEY);
 * no research key is touched. Nothing is written to the database.
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import type { ResearchBundle } from "./agents/research";
import { runWriting } from "./agents/writing";
import { runQA } from "./agents/qa";
import { buildCombinedDocx, RunEntry, ResearchRunEntry } from "./lib/docx-combined";
import { resolveVariant, runPaths, stripFlags } from "./run-config";

const VARIANT = resolveVariant();
const PATHS = runPaths(VARIANT);

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

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every bundle in the variant's research-only log, newest entry per topic. */
function bundlesFromLog(): { topic: string; bundle: ResearchBundle; from: string }[] {
  const log = readJson<ResearchRunEntry[]>(PATHS.researchOnlyLogPath);
  if (!Array.isArray(log)) return [];
  return log
    .filter((e) => e?.topic && e?.bundle)
    .map((e) => ({
      topic: e.topic,
      bundle: e.bundle,
      from: path.basename(PATHS.researchOnlyLogPath),
    }));
}

/**
 * Newest saved bundle for a topic in the variant's research folder — the
 * fallback for a topic that isn't in the log (e.g. the log was reset, or the
 * bundle came from a full pipeline run).
 */
function bundleFromDisk(topic: string): { bundle: ResearchBundle; from: string } | null {
  const dir = PATHS.researchDir;
  if (!fs.existsSync(dir)) return null;
  const prefix = `${slugify(topic)}-`;
  const match = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .pop();
  if (!match) return null;
  const bundle = readJson<ResearchBundle>(path.join(dir, match));
  return bundle ? { bundle, from: `${path.basename(dir)}/${match}` } : null;
}

function loadRunLog(): RunEntry[] {
  const parsed = readJson<RunEntry[]>(PATHS.logPath);
  return Array.isArray(parsed) ? parsed : [];
}

/** Add a run, replacing any previous run(s) of the same topic. */
function upsertEntry(log: RunEntry[], entry: RunEntry): void {
  const key = entry.topic.trim().toLowerCase();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].topic.trim().toLowerCase() === key) log.splice(i, 1);
  }
  log.push(entry);
}

async function saveLogAndRebuildDoc(log: RunEntry[]): Promise<void> {
  fs.writeFileSync(PATHS.logPath, JSON.stringify(log, null, 2), "utf8");
  try {
    fs.writeFileSync(PATHS.docPath, await buildCombinedDocx(log));
    console.log(`[Write+QA] Master document updated: ${PATHS.docPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EPERM") {
      console.error(
        `[Write+QA] Could not write ${PATHS.docPath} — it's probably open in Word. ` +
          `Close it and re-run; the run data is safe in ${PATHS.logPath}.`
      );
    } else {
      throw err;
    }
  }
}

async function main(): Promise<void> {
  const args = stripFlags();
  const dryRun = args.some((a) => a === "--dry-run" || a === "-n");
  const requested = args
    .filter((a) => !a.startsWith("-"))
    .join(" ")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const available = bundlesFromLog();
  const selected: { topic: string; bundle: ResearchBundle; from: string }[] = [];

  if (requested.length === 0) {
    selected.push(...available);
  } else {
    for (const topic of requested) {
      const key = slugify(topic);
      const hit = available.find((a) => slugify(a.topic) === key);
      if (hit) {
        selected.push(hit);
        continue;
      }
      const disk = bundleFromDisk(topic);
      if (disk) {
        selected.push({ topic, bundle: disk.bundle, from: disk.from });
        continue;
      }
      console.error(`[Write+QA] No saved research bundle found for "${topic}".`);
    }
  }

  if (selected.length === 0) {
    console.error(
      `Nothing to do for ${PATHS.label}. Available topics in ${path.basename(
        PATHS.researchOnlyLogPath
      )}: ${available.map((a) => a.topic).join(", ") || "(none)"}`
    );
    process.exit(1);
  }

  console.log(`Research source: ${PATHS.label} (already-completed research — no new research calls)`);
  for (const s of selected) {
    console.log(
      `  • ${s.topic} — ${s.bundle.facts.length} facts, ${s.bundle.sources.length} sources, ` +
        `status=${s.bundle.status}, tier=${s.bundle.significance_tier}   [${s.from}]`
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing was called. Drop the flag to run Writing + QA.");
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\nANTHROPIC_API_KEY is not set (needed for the Writing Agent). Add it to worker/.env.");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("\nOPENAI_API_KEY is not set (needed for the QA Agent). Add it to worker/.env.");
    process.exit(1);
  }

  fs.mkdirSync(PATHS.articlesDir, { recursive: true });
  fs.mkdirSync(PATHS.qaDir, { recursive: true });

  const log = loadRunLog();
  let written = 0;
  let needsHuman = 0;
  let failed = 0;
  const qaVerdicts: Record<string, number> = {};

  for (const { topic, bundle } of selected) {
    console.log(`\n${"=".repeat(70)}\n${topic}\n${"=".repeat(70)}`);
    const base = `${slugify(topic)}-${timestamp()}`;

    const entry: RunEntry = {
      run_at: new Date().toISOString(),
      topic,
      category: bundle.category,
      bundle,
      article: null,
    };

    // Same gate the full pipeline applies before the Writing Agent.
    if (bundle.status === "needs_human_research") {
      console.log(
        `[Write+QA] "${topic}" NEEDS HUMAN RESEARCH — no usable material in approved sources. Skipping.\n`
      );
      entry.note =
        "NEEDS HUMAN RESEARCH — no usable material found in approved sources; Writing Agent skipped.";
      needsHuman++;
      upsertEntry(log, entry);
      await saveLogAndRebuildDoc(log);
      continue;
    }

    // ── Writing ───────────────────────────────────────────────────────────────
    try {
      const article = await runWriting(bundle);
      const jsonPath = path.join(PATHS.articlesDir, `${base}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(article, null, 2), "utf8");
      console.log(`[Write+QA] Article saved: ${jsonPath}`);
      entry.article = article;
      written++;
    } catch (err) {
      console.error(`[Write+QA] Writing FAILED for "${topic}":`, err, "\n");
      entry.note = `Writing Agent FAILED: ${err instanceof Error ? err.message : String(err)}`;
      failed++;
    }

    // ── QA (only when an article exists) ─────────────────────────────────────
    if (entry.article) {
      try {
        const report = await runQA({ article: entry.article, research_bundle: bundle });
        const jsonPath = path.join(PATHS.qaDir, `${base}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
        console.log(`[Write+QA] QA report saved: ${jsonPath}\n`);
        entry.qa = report;
        qaVerdicts[report.verdict] = (qaVerdicts[report.verdict] ?? 0) + 1;
      } catch (err) {
        console.error(`[Write+QA] QA FAILED for "${topic}":`, err, "\n");
        entry.qa = null;
        entry.qa_note = `QA Agent FAILED: ${
          err instanceof Error ? err.message : String(err)
        } — the article above is UNREVIEWED.`;
        failed++;
      }
    }

    // Saved after every topic, so an interruption keeps what already finished.
    upsertEntry(log, entry);
    await saveLogAndRebuildDoc(log);
  }

  const verdictSummary = Object.entries(qaVerdicts)
    .map(([verdict, count]) => `${count} ${verdict}`)
    .join(", ");
  console.log(
    `\nDone. ${written} article(s) written, ${needsHuman} need(s) human research, ${failed} failed.` +
      (verdictSummary ? ` QA verdicts: ${verdictSummary}.` : "")
  );
  console.log(`Review everything in: ${PATHS.docPath}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
