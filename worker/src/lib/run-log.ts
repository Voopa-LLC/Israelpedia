/**
 * The .docx sink: the combined review document for LOCAL runs.
 *
 * This is the counterpart to lib/publish-topic.ts. It exists so the agents can
 * be inspected in Word without anything reaching the site — the workflow the
 * pipeline was built and tested with, kept exactly as it was.
 *
 * The cloud service never calls any of this. A container's filesystem is wiped
 * on every redeploy, and rebuilding the whole document after each topic is
 * quadratic work that a nine-thousand-topic drain would not survive: the log is
 * roughly 140 KB per topic, and the .docx format cannot be appended to in
 * place, so the entire file is regenerated from runs-log.json every time.
 * That cost is fine for a handful of local test topics and nothing else.
 */
import fs from "fs";
import { buildCombinedDocx, type RunEntry } from "./docx-combined";
import type { TopicRunResult } from "./run-topic";

/** Read the accumulated log, setting a corrupt one aside rather than losing it. */
export function loadRunLog(logPath: string): RunEntry[] {
  if (!fs.existsSync(logPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, "utf8"));
    return Array.isArray(parsed) ? (parsed as RunEntry[]) : [];
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backup = logPath.replace(/\.json$/, `.corrupt-${stamp}.json`);
    fs.renameSync(logPath, backup);
    console.warn(`[RunLog] runs-log.json was unreadable — moved to ${backup}`);
    return [];
  }
}

/**
 * Add a run to the log, replacing any previous run(s) of the same topic so the
 * document never shows one topic twice. The raw per-stage JSONs of older runs
 * stay on disk untouched.
 */
export function upsertEntry(log: RunEntry[], entry: RunEntry): void {
  const key = entry.topic.trim().toLowerCase();
  const previous = log.filter((e) => e.topic.trim().toLowerCase() === key);
  if (previous.length > 0) {
    console.log(
      `[RunLog] Replacing ${previous.length} previous run(s) of "${entry.topic}" in the document`
    );
    for (const old of previous) log.splice(log.indexOf(old), 1);
  }
  log.push(entry);
}

export async function saveLogAndRebuildDoc(
  log: RunEntry[],
  logPath: string,
  docPath: string
): Promise<void> {
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf8");
  try {
    fs.writeFileSync(docPath, await buildCombinedDocx(log));
    console.log(`[RunLog] Master document updated: ${docPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EBUSY" || code === "EPERM") {
      console.error(
        `[RunLog] Could not write ${docPath} — the file is probably open in Word. ` +
          `Close it and re-run; the run data is safe in ${logPath}.`
      );
    } else {
      throw err;
    }
  }
}

/**
 * Turn a pipeline result into a document entry.
 *
 * Returns null when the Research Agent failed: there is no bundle, and an entry
 * with nothing in it would just be a blank page in the document.
 */
export function entryFromResult(topic: string, result: TopicRunResult): RunEntry | null {
  if (!result.bundle) return null;

  const entry: RunEntry = {
    run_at: new Date().toISOString(),
    topic,
    // The category the Research Agent resolved, not the one the topic row asked
    // for — the input's is optional.
    category: result.bundle.category,
    bundle: result.bundle,
    article: result.article,
    qa: result.qa,
  };

  if (result.needsHumanResearch) {
    entry.note =
      "NEEDS HUMAN RESEARCH — no usable material found in approved sources; Writing Agent skipped.";
  } else if (result.writingError) {
    entry.note = `Writing Agent FAILED: ${result.writingError}`;
  }

  if (result.qaError) {
    entry.qa_note = `QA Agent FAILED: ${result.qaError} — the article above is UNREVIEWED.`;
  }

  return entry;
}
