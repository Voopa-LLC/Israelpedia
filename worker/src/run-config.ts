/**
 * Which Research Agent a manual run uses, and where its output goes.
 *
 * Three research agents exist and produce the identical `research_bundle`
 * contract, so the Writing and QA agents run unchanged behind any of them:
 *
 *   perplexity  (default)  agents/research.ts        — sonar-pro
 *   claude      (--claude) agents/research-claude.ts — claude-sonnet-5 + web search/fetch
 *   gpt         (--gpt)    agents/research-gpt.ts    — gpt-5.6-sol + web search/fetch
 *
 * Each variant writes to its OWN output folders, run log, and master Word
 * document. That is deliberate: the run log is keyed by topic, so a shared log
 * would make one agent's run silently overwrite another's on the same topic —
 * exactly the comparison you want to keep.
 */
import path from "path";

export type ResearchVariant = "perplexity" | "claude" | "gpt";

export interface RunPaths {
  variant: ResearchVariant;
  /** Human-readable name for log lines. */
  label: string;
  outputDir: string;
  researchDir: string;
  articlesDir: string;
  qaDir: string;
  logPath: string;
  docPath: string;
  /** Research-only runs (npm run research:only) keep their own log + document. */
  researchOnlyLogPath: string;
  researchOnlyDocPath: string;
}

/** CLI flags that select a non-default research agent. */
const VARIANT_FLAGS: Record<string, ResearchVariant> = {
  "--claude": "claude",
  "-c": "claude",
  "--gpt": "gpt",
  "-g": "gpt",
};

/** Read the variant from process.argv (default: perplexity). */
export function resolveVariant(argv: string[] = process.argv.slice(2)): ResearchVariant {
  for (const arg of argv) {
    const variant = VARIANT_FLAGS[arg];
    if (variant) return variant;
  }
  return "perplexity";
}

/**
 * Flags that control WHERE a local run gets its topics and where its output
 * goes. The variant flags above choose which research agent runs.
 *
 * A local run defaults to the review document and writes nothing to the site;
 * `--publish` is what switches it to the database path.
 */
export interface RunFlags {
  /**
   * Work from src/manual-topics.ts instead of the `topics` table.
   * Local runs write nothing to the database either way; this only changes
   * where the topics come from.
   */
  manual: boolean;
  /**
   * Opt a LOCAL run into the database path: claim topics off the queue, publish
   * the articles, and record the outcome on the topic row — exactly what the
   * cloud service does, and no .docx.
   *
   * Without it, `npm run research` reviews the agents in Word and touches
   * nothing on the site. That default is deliberate: the automated pipeline is
   * what publishes now, so a local run is for checking the agents, and the
   * write path has to be asked for explicitly.
   */
  publish: boolean;
  /** With --publish: run the agents but skip saving; the queue is still updated. */
  dryRun: boolean;
  /**
   * Save articles as `status: "review"` instead of publishing them.
   * AI articles normally go live immediately; this holds a run back for
   * inspection without changing the default for everyone else.
   */
  review: boolean;
  /** Stop after this many topics. null = drain the queue. */
  limit: number | null;
}

const BOOLEAN_FLAGS = ["--manual", "-m", "--publish", "--dry-run", "--review"];
/** Flags that consume the following argument (`--limit 5`). */
const VALUE_FLAGS = ["--limit", "-n"];

export function resolveFlags(argv: string[] = process.argv.slice(2)): RunFlags {
  const manual = argv.includes("--manual") || argv.includes("-m");
  const publish = argv.includes("--publish");
  const dryRun = argv.includes("--dry-run");
  const review = argv.includes("--review");

  let limit: number | null = null;
  for (const flag of VALUE_FLAGS) {
    const i = argv.indexOf(flag);
    if (i !== -1) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isInteger(parsed) || parsed < 1) {
        console.error(`${flag} needs a positive whole number, e.g. \`${flag} 5\`.`);
        process.exit(1);
      }
      limit = parsed;
    }
  }

  return { manual, publish, dryRun, review, limit };
}

/**
 * argv minus every flag this runner understands (and any value they consume),
 * so positional args — e.g. a comma-separated topic list — still work.
 */
export function stripFlags(argv: string[] = process.argv.slice(2)): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VARIANT_FLAGS[arg] || BOOLEAN_FLAGS.includes(arg)) continue;
    if (VALUE_FLAGS.includes(arg)) {
      i++; // also drop the value that follows
      continue;
    }
    out.push(arg);
  }
  return out;
}

const LABELS: Record<ResearchVariant, string> = {
  perplexity: "Perplexity (sonar-pro)",
  claude: "Claude (claude-sonnet-5)",
  gpt: "GPT (gpt-5.6-sol)",
};

/** Filename suffix per variant — Perplexity keeps the original, unsuffixed paths. */
const SUFFIXES: Record<ResearchVariant, string> = {
  perplexity: "",
  claude: "-claude",
  gpt: "-gpt",
};

const DOC_NAMES: Record<ResearchVariant, string> = {
  perplexity: "IsraelPedia-Runs.docx",
  claude: "IsraelPedia-Runs-Claude.docx",
  gpt: "IsraelPedia-Runs-GPT.docx",
};

const RESEARCH_ONLY_DOC_NAMES: Record<ResearchVariant, string> = {
  perplexity: "IsraelPedia-Research-Only.docx",
  claude: "IsraelPedia-Research-Only-Claude.docx",
  gpt: "IsraelPedia-Research-Only-GPT.docx",
};

/**
 * Env vars each research agent reads for its API key, in priority order. The
 * research agents have their own keys so their spend and rate limits are
 * tracked separately from the Writing Agent (ANTHROPIC_API_KEY) and the QA
 * Agent (OPENAI_API_KEY), which keep using the shared ones. The second entry is
 * the fallback the agent uses when the dedicated key isn't set.
 */
const RESEARCH_KEY_VARS: Record<ResearchVariant, string[]> = {
  perplexity: ["PERPLEXITY_API_KEY"],
  claude: ["ANTHROPIC_API_KEY_RESEARCH", "ANTHROPIC_API_KEY"],
  gpt: ["OPENAI_API_KEY_RESEARCH", "OPENAI_API_KEY"],
};

export function researchKeyVars(variant: ResearchVariant): string[] {
  return RESEARCH_KEY_VARS[variant];
}

/** The env var this variant's research agent will actually use, or null if none is set. */
export function researchKeyVar(variant: ResearchVariant): string | null {
  return RESEARCH_KEY_VARS[variant].find((name) => process.env[name]) ?? null;
}

/**
 * Fail early (and clearly) when the selected research agent has no key, and
 * warn when it is falling back off its dedicated one. Exits the process on a
 * hard miss — call it before doing any work.
 */
export function assertResearchKey(variant: ResearchVariant, label: string): void {
  const vars = RESEARCH_KEY_VARS[variant];
  const found = researchKeyVar(variant);
  if (!found) {
    console.error(
      `No API key for the ${label} research agent. Set ${vars.join(" or ")} in worker/.env and retry.`
    );
    process.exit(1);
  }
  if (found !== vars[0]) {
    console.warn(
      `[warn] ${vars[0]} is not set — the research agent is falling back to ${found}, ` +
        `so its usage will not be tracked separately.`
    );
  }
}

export function runPaths(variant: ResearchVariant): RunPaths {
  const outputDir = path.resolve(process.cwd(), "output");
  // The Perplexity paths are the original ones — existing output stays put.
  const suffix = SUFFIXES[variant];
  return {
    variant,
    label: LABELS[variant],
    outputDir,
    researchDir: path.join(outputDir, `research${suffix}`),
    articlesDir: path.join(outputDir, `articles${suffix}`),
    qaDir: path.join(outputDir, `qa${suffix}`),
    logPath: path.join(outputDir, `runs-log${suffix}.json`),
    docPath: path.join(outputDir, DOC_NAMES[variant]),
    researchOnlyLogPath: path.join(outputDir, `research-only-log${suffix}.json`),
    researchOnlyDocPath: path.join(outputDir, RESEARCH_ONLY_DOC_NAMES[variant]),
  };
}
