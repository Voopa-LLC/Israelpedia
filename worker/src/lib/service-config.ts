/**
 * How the always-on cloud service is configured.
 *
 * The CLI takes flags; the service takes environment variables, because that is
 * what a hosting dashboard gives you. Every one has a safe default.
 *
 * The ON/OFF SWITCH IS NOT HERE. It lives in the database, so an admin can
 * start and stop the pipeline from /admin/topics without a redeploy — see
 * lib/pipeline-control.ts. What is left in this file is tuning: which research
 * agent, how hard to push it, when to stop.
 */
import { resolveVariant, type ResearchVariant } from "../run-config";

export interface ServiceConfig {
  variant: ResearchVariant;
  /** Pause between topics, to stay inside the model providers' rate limits. */
  delayMs: number;
  /** How long to wait before checking an empty queue again. */
  idlePollMs: number;
  /**
   * Stop after this many topics and idle. A safety cap for the first live runs
   * — null means keep going for as long as there are topics.
   */
  maxTopics: number | null;
  /** Hold articles in the admin review queue instead of publishing them. */
  review: boolean;
  /**
   * How often to re-read the on/off switch. Also the heartbeat interval, and
   * therefore how long Start and Stop take to be noticed.
   *
   * Every poll is one small query, so this is cheap — but it never stops, which
   * means an idle worker keeps the Neon compute awake around the clock. Raise it
   * if that matters more than the button feeling instant.
   */
  controlPollMs: number;
}

const TRUE = ["true", "1", "yes", "on"];
const FALSE = ["false", "0", "no", "off"];

/**
 * A switch from the environment.
 *
 * Several spellings of yes are accepted on purpose: a dashboard value of "yes"
 * that silently reads as off is a confusing way to lose an afternoon. Anything
 * unrecognised warns and falls back — it never guesses "on".
 */
function bool(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (TRUE.includes(raw)) return true;
  if (FALSE.includes(raw)) return false;
  console.warn(`[Config] ${name}="${raw}" is not a yes/no value — treating it as ${fallback}.`);
  return fallback;
}

/**
 * A positive number from the environment, or the default.
 *
 * Anything unparseable falls back with a warning rather than throwing: a typo
 * in one tuning value must not stop the service from running.
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[Config] ${name}="${raw}" is not a positive number — using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

const VARIANTS: ResearchVariant[] = ["perplexity", "claude", "gpt"];

export function serviceConfig(): ServiceConfig {
  const requested = process.env.PIPELINE_VARIANT?.trim().toLowerCase();
  let variant: ResearchVariant;
  if (requested && VARIANTS.includes(requested as ResearchVariant)) {
    variant = requested as ResearchVariant;
  } else {
    if (requested) {
      console.warn(
        `[Config] PIPELINE_VARIANT="${requested}" is not one of ${VARIANTS.join(", ")} — ` +
          `using the default.`
      );
    }
    // Falls back to the CLI resolver so a local `node dist/... --gpt` still works.
    variant = resolveVariant();
  }

  const maxTopics = num("PIPELINE_MAX_TOPICS", 0);

  return {
    variant,
    delayMs: num("PIPELINE_DELAY_MS", 5_000),
    idlePollMs: num("PIPELINE_IDLE_POLL_MS", 60_000),
    maxTopics: maxTopics > 0 ? Math.floor(maxTopics) : null,
    review: bool("PIPELINE_REVIEW"),
    controlPollMs: Math.max(5_000, num("PIPELINE_CONTROL_POLL_MS", 20_000)),
  };
}

/** One-line summary for the boot log, so a deployment shows its own settings. */
export function describeConfig(config: ServiceConfig): string {
  return [
    `variant=${config.variant}`,
    `delay=${config.delayMs}ms`,
    `idlePoll=${config.idlePollMs}ms`,
    `maxTopics=${config.maxTopics ?? "unlimited"}`,
    `saveAs=${config.review ? "review" : "published"}`,
    `switchPoll=${config.controlPollMs}ms`,
  ].join("  ");
}
