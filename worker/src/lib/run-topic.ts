/**
 * One topic through the three agents: Research → Writing → QA.
 *
 * This module has no opinion about where the result goes. It never touches the
 * database and never writes a Word document. Those are the two sinks that sit
 * on top of it:
 *
 *   lib/publish-topic.ts  → the database. What the cloud service does: the
 *                           article goes live on the site and the topic row is
 *                           updated. No files, ever.
 *   lib/run-log.ts        → the combined .docx. What a local CLI run does, so
 *                           the agents can be reviewed without writing
 *                           anything to the site.
 *
 * Keeping the agents behind one entry point is the whole point of the split:
 * both sinks run the identical pipeline, so what you check in Word locally is
 * exactly what the service publishes.
 *
 * Never throws for an agent failure. A bad topic must not stop a queue drain,
 * so each stage's failure is captured on the result and the caller decides what
 * it means.
 */
import { runResearch, type ResearchBundle, type ResearchInput } from "../agents/research";
import { runResearchClaude } from "../agents/research-claude";
import { runResearchGPT } from "../agents/research-gpt";
import { runWriting, type WrittenArticle } from "../agents/writing";
import { runQA, type QAReport } from "../agents/qa";
import type { ResearchVariant } from "../run-config";

/**
 * The Research Agents, keyed by variant. All three emit the identical
 * research_bundle, so the Writing and QA stages run unchanged behind any of them.
 */
const RESEARCH_AGENTS = {
  perplexity: runResearch,
  claude: runResearchClaude,
  gpt: runResearchGPT,
} as const;

/** The three stages that produce a saveable artefact. */
export type Stage = "research" | "article" | "qa";

export interface RunTopicOptions {
  variant: ResearchVariant;
  /**
   * Called with each stage's output as it completes. The CLI uses it to drop
   * the per-stage JSON into worker/output/; the service passes nothing, because
   * a container's filesystem is wiped on every redeploy and the database
   * already holds everything that matters.
   */
  saveStageFile?: (stage: Stage, data: unknown) => void;
}

export interface TopicRunResult {
  bundle: ResearchBundle | null;
  article: WrittenArticle | null;
  qa: QAReport | null;
  /** Set when that stage threw. Null means the stage ran (or was skipped). */
  researchError: string | null;
  writingError: string | null;
  qaError: string | null;
  /**
   * The Research Agent found no usable material in approved sources, so the
   * Writing Agent was deliberately skipped. Not a failure — a topic that needs
   * a person.
   */
  needsHumanResearch: boolean;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the run produced an article worth saving or reviewing. */
export function hasArticle(result: TopicRunResult): boolean {
  return result.article !== null;
}

export async function runTopic(
  input: ResearchInput,
  options: RunTopicOptions
): Promise<TopicRunResult> {
  const result: TopicRunResult = {
    bundle: null,
    article: null,
    qa: null,
    researchError: null,
    writingError: null,
    qaError: null,
    needsHumanResearch: false,
  };

  // ── Stage 1: Research ───────────────────────────────────────────────────────
  try {
    result.bundle = await RESEARCH_AGENTS[options.variant](input);
    options.saveStageFile?.("research", result.bundle);
  } catch (err) {
    console.error(`[Pipeline] Research FAILED for "${input.topic}":`, err, "\n");
    result.researchError = errorText(err);
    return result;
  }

  // ── Gate: reject unwritable bundles before spending on the Writing Agent ────
  if (result.bundle.status === "needs_human_research") {
    console.log(
      `[Pipeline] "${input.topic}" NEEDS HUMAN RESEARCH — no usable material in ` +
        `approved sources. Skipping the Writing Agent.\n`
    );
    result.needsHumanResearch = true;
    return result;
  }

  // ── Stage 2: Writing ────────────────────────────────────────────────────────
  try {
    result.article = await runWriting(result.bundle);
    options.saveStageFile?.("article", result.article);
  } catch (err) {
    console.error(`[Pipeline] Writing FAILED for "${input.topic}":`, err, "\n");
    result.writingError = errorText(err);
    return result;
  }

  // ── Stage 3: QA ─────────────────────────────────────────────────────────────
  // A QA failure is NOT fatal: the article exists, it is simply unchecked. The
  // caller decides what to do with it (the database sink parks it as a draft).
  try {
    result.qa = await runQA({ article: result.article, research_bundle: result.bundle });
    options.saveStageFile?.("qa", result.qa);
  } catch (err) {
    console.error(`[Pipeline] QA FAILED for "${input.topic}":`, err, "\n");
    result.qaError = errorText(err);
  }

  return result;
}
