/**
 * Research-only runner — runs JUST the Research Agent, no Writing, no QA.
 *
 * Usage (from the worker/ folder):
 *   npm run research:only               — Perplexity agent, topics from src/manual-topics.ts
 *   npm run research:only:claude        — Claude agent, topics from src/manual-topics.ts
 *   npm run research:only:gpt           — GPT agent, topics from src/manual-topics.ts
 *   npm run research:only -- "Tel Aviv"             — one ad-hoc topic
 *   npm run research:only:claude -- "Tel Aviv, Likud" — several, comma-separated
 *
 * Ad-hoc topics given on the command line REPLACE the manual-topics.ts list for
 * that run, so you can probe a single topic without editing the file.
 *
 * You get the results in three places:
 *   1. The console — per topic: status, tier, confidence, and every fact with
 *      its source, plus the yield breakdown (facts per domain / source type).
 *   2. A Word document you can read through:
 *        worker/output/IsraelPedia-Research-Only.docx          (Perplexity)
 *        worker/output/IsraelPedia-Research-Only-Claude.docx   (Claude)
 *        worker/output/IsraelPedia-Research-Only-GPT.docx      (GPT)
 *   3. The raw bundle JSON, same folder the full pipeline uses:
 *        worker/output/research/<topic-slug>-<timestamp>.json          (Perplexity)
 *        worker/output/research-claude/<topic-slug>-<timestamp>.json   (Claude)
 *        worker/output/research-gpt/<topic-slug>-<timestamp>.json      (GPT)
 *
 * Each variant keeps its own document and log, so running the same topic
 * through all three agents gives you a side-by-side rather than an overwrite.
 * Within one variant, re-running a topic replaces its previous entry.
 *
 * Nothing is written to the database, and no article is produced.
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { runResearch, type ResearchBundle, type ResearchInput } from "./agents/research";
import { runResearchClaude } from "./agents/research-claude";
import { runResearchGPT } from "./agents/research-gpt";
import { MANUAL_TOPICS } from "./manual-topics";
import { buildResearchDocx, ResearchRunEntry } from "./lib/docx-combined";
import { peekPendingTopics, toResearchInput } from "./lib/topics-queue";
import { closeDb } from "./lib/db";
import { assertResearchKey, resolveFlags, resolveVariant, runPaths, stripFlags } from "./run-config";

const VARIANT = resolveVariant();
const FLAGS = resolveFlags();
const PATHS = runPaths(VARIANT);
const LOG_PATH = PATHS.researchOnlyLogPath;
const DOC_PATH = PATHS.researchOnlyDocPath;

/** All three agents share the ResearchInput → ResearchBundle contract. */
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

/**
 * Topics for this run, in order of precedence:
 *   1. comma-separated names given on the command line
 *   2. --manual → the manual-topics.ts list
 *   3. the pending topics in the database queue
 *
 * This is an inspection-only runner: it produces no article, so it PEEKS at the
 * queue rather than claiming from it. Nothing here changes a topic's status.
 */
async function resolveTopics(): Promise<ResearchInput[]> {
  const args = stripFlags().join(" ").trim();
  if (args) {
    return args
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((topic) => ({ topic }));
  }

  if (FLAGS.manual) return MANUAL_TOPICS;

  const rows = await peekPendingTopics(FLAGS.limit ?? 25);
  if (rows.length > 0) {
    console.log(
      `[Research-only] Previewing ${rows.length} pending topic(s) from the queue ` +
        `(their status is left untouched).`
    );
  }
  return rows.map(toResearchInput);
}

function loadLog(): ResearchRunEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as ResearchRunEntry[]) : [];
  } catch {
    // Don't lose a corrupt log — set it aside and start fresh.
    const backup = LOG_PATH.replace(/\.json$/, `.corrupt-${timestamp()}.json`);
    fs.renameSync(LOG_PATH, backup);
    console.warn(`[Research-only] Log was unreadable — moved to ${backup}`);
    return [];
  }
}

/** Add an entry, replacing any previous run of the same topic. */
function upsertEntry(log: ResearchRunEntry[], entry: ResearchRunEntry): void {
  const key = entry.topic.trim().toLowerCase();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].topic.trim().toLowerCase() === key) log.splice(i, 1);
  }
  log.push(entry);
}

async function saveLogAndRebuildDoc(log: ResearchRunEntry[]): Promise<void> {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), "utf8");
  try {
    fs.writeFileSync(DOC_PATH, await buildResearchDocx(log));
    console.log(`[Research-only] Document updated: ${DOC_PATH}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EPERM") {
      console.error(
        `[Research-only] Could not write ${DOC_PATH} — it's probably open in Word. ` +
          `Close it and re-run; the run data is safe in ${LOG_PATH}.`
      );
    } else {
      throw err;
    }
  }
}

/** Counts of something, richest first, as "key n, key n". */
function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none"
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url;
  }
}

/** The whole point of this command: show what the agent actually returned. */
function printBundle(bundle: ResearchBundle): void {
  const domains = bundle.facts.map((f) => hostOf(f.source_url));
  const distinctDomains = new Set(domains).size;

  console.log(
    `\n  status=${bundle.status}  category=${bundle.category}  ` +
      `tier=${bundle.significance_tier}  confidence=${bundle.confidence_score}`
  );
  console.log(
    `  ${bundle.facts.length} facts  •  ${bundle.sources.length} sources  •  ` +
      `${distinctDomains} distinct domains  •  ` +
      `${bundle.distinctive_material.length} distinctive  •  ` +
      `${bundle.controversy_flags.length} controversy flag(s)`
  );
  console.log(`  by source type: ${tally(bundle.facts.map((f) => f.source_type))}`);
  console.log(`  by domain:      ${tally(domains)}`);

  console.log(`\n  ── Facts (${bundle.facts.length}) ──`);
  if (bundle.facts.length === 0) {
    console.log("  (none found in approved sources)");
  }
  bundle.facts.forEach((f, i) => {
    const flag = f.controversy_flag ? "  [CONTROVERSIAL]" : "";
    const opinion = f.opinion_only ? "  [OPINION]" : "";
    console.log(`\n  ${i + 1}. ${f.text}`);
    console.log(
      `     ↳ ${f.source_name} — ${f.source_url}  (${f.source_type}, ${f.confidence})${flag}${opinion}`
    );
  });

  if (bundle.distinctive_material.length > 0) {
    console.log(`\n  ── Distinctive material (${bundle.distinctive_material.length}) ──`);
    bundle.distinctive_material.forEach((d, i) => {
      console.log(`\n  ${i + 1}. [${d.type.toUpperCase()}] ${d.text}`);
      console.log(`     ↳ ${d.source_name} — ${d.source_url}`);
    });
  }

  if (bundle.controversy_flags.length > 0) {
    console.log(`\n  ── Controversy flags (${bundle.controversy_flags.length}) ──`);
    bundle.controversy_flags.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }

  console.log(`\n  ── Sources (${bundle.sources.length}) ──`);
  bundle.sources.forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.name} — ${s.url}  (accessed ${s.accessed_date})`)
  );
}

async function main(): Promise<void> {
  // Only the selected research agent's key is required — no Writing or QA
  // stage runs here, so no other keys are needed.
  assertResearchKey(VARIANT, PATHS.label);

  const topics = await resolveTopics();
  if (topics.length === 0) {
    console.log(
      "No topics — add some at /admin/topics, pass them on the command line " +
        "(`npm run research:only -- \"Tel Aviv, Hebron\"`), or use --manual for src/manual-topics.ts."
    );
    return;
  }

  fs.mkdirSync(PATHS.researchDir, { recursive: true });
  const log = loadLog();

  console.log(`Research Agent: ${PATHS.label}   (research only — no Writing, no QA)`);
  console.log(
    `Processing ${topics.length} topic(s): ${topics.map((t) => t.topic).join(", ")}\n`
  );

  let ok = 0;
  let failed = 0;
  const summary: string[] = [];

  for (const input of topics) {
    console.log(`\n${"=".repeat(70)}\n${input.topic}\n${"=".repeat(70)}`);
    try {
      const bundle = await runResearchAgent(input);

      const jsonPath = path.join(
        PATHS.researchDir,
        `${slugify(input.topic)}-${timestamp()}.json`
      );
      fs.writeFileSync(jsonPath, JSON.stringify(bundle, null, 2), "utf8");

      printBundle(bundle);
      console.log(`\n  Raw bundle saved: ${jsonPath}`);

      upsertEntry(log, {
        run_at: new Date().toISOString(),
        topic: input.topic,
        agent: PATHS.label,
        bundle,
      });
      await saveLogAndRebuildDoc(log);

      summary.push(
        `${input.topic}: ${bundle.facts.length} facts, ${bundle.sources.length} sources, ` +
          `status=${bundle.status}, tier=${bundle.significance_tier}`
      );
      ok++;
    } catch (err) {
      console.error(`\n[Research-only] FAILED for "${input.topic}":`, err);
      summary.push(`${input.topic}: FAILED`);
      failed++;
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Done — ${ok} succeeded, ${failed} failed.  Agent: ${PATHS.label}`);
  summary.forEach((line) => console.log(`  • ${line}`));
  console.log(`\nRead the full output in: ${DOC_PATH}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
