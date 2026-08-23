import type { ResearchInput } from "./agents/research";

/**
 * Fallback topic list for one-off tests.
 *
 * The pipeline normally takes its topics from the `topics` table in the
 * database — add them at /admin/topics or with `npm run topics:import`. This
 * list is only used when a runner is given `--manual`:
 *
 *   npm run research -- --manual        # full pipeline, files only, NO database
 *   npm run research:only -- --manual   # research stage only
 *
 * In --manual mode nothing is written to the database at all: no article is
 * saved and no topic row is touched. Everything accumulates in
 * worker/output/IsraelPedia-Runs.docx plus the raw .json per stage, which makes
 * it the right mode for trying a prompt change without dirtying the queue.
 *
 * Only the topic NAME is required — just add `{ topic: "Tel Aviv" }`. The
 * Research Agent classifies the category (person/place/event/concept) itself.
 * `category` and `aliases` are optional overrides you can add if you want to
 * force a specific classification or feed alternate spellings.
 */
export const MANUAL_TOPICS: ResearchInput[] = [
  { topic: "Energy in Israel" },
  { topic: "Biblical minimalism" },
  { topic: "Zvi Yehuda Kook" },
  { topic: "Ma'alot-Tarshiha" },
  { topic: "Zeev Rosenstein" },
  { topic: "Menasseh Ben Israel" },
  { topic: "2008 Jerusalem bulldozer attack" },
  { topic: "Keshet Media Group" },
  { topic: "Vehicle registration plates of Israel" },
  { topic: "General Staff of the Israel Defense Forces" },
];
