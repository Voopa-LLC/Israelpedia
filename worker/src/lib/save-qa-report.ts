/**
 * Store the QA Agent's full report for one run in `article_qa_reports`, so the
 * admin panel can show it at /admin/qa/<slug>.
 *
 * This is separate from the four-field summary the runner writes back onto the
 * topic row (qa_verdict, qa_confidence, qa_issue_count, qa_summary). That
 * summary is the queue's status line and is overwritten on every re-run; this
 * is the report itself, one row per run, and re-running a topic adds a row
 * rather than erasing the previous one.
 *
 * `report.edited_article` is deliberately not stored: it is the article that
 * was just saved, and it already lives in `articles`.
 *
 * Call this only AFTER saveArticle() has succeeded — the row's article_id is a
 * foreign key, and a report about an article that was never saved is noise.
 */
import { articleQaReports } from "../../../db/schema";
import type { QAReport } from "../agents/qa";
import { getDb } from "./db";

export interface SaveQaReportInput {
  /** The article the report is about — from saveArticle()'s result. */
  articleId: string;
  /** The queue row this run came from, when there was one. */
  topicId?: string | null;
  report: QAReport;
  /** perplexity | claude | gpt. */
  researchVariant?: string | null;
  /** The status the article was saved with on the back of this verdict. */
  savedStatus: "published" | "review" | "draft";
}

export async function saveQaReport(input: SaveQaReportInput): Promise<string> {
  const { report } = input;
  // The agent's JSON is validated upstream, but a stored report is a permanent
  // record — take the arrays defensively rather than write null into a NOT NULL
  // column on a malformed run.
  const changes = Array.isArray(report.changes) ? report.changes : [];
  const issues = Array.isArray(report.issues) ? report.issues : [];

  const [row] = await getDb()
    .insert(articleQaReports)
    .values({
      articleId: input.articleId,
      topicId: input.topicId ?? null,
      verdict: report.verdict,
      // Only a reject carries a target; store null rather than "undefined".
      rejectTarget: report.reject_target ?? null,
      confidence: typeof report.confidence === "number" && Number.isFinite(report.confidence)
        ? report.confidence
        : null,
      summary: report.summary ?? null,
      changes,
      issues,
      changeCount: changes.length,
      issueCount: issues.length,
      researchVariant: input.researchVariant ?? null,
      savedStatus: input.savedStatus,
    })
    .returning({ id: articleQaReports.id });

  return row.id;
}
