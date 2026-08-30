/**
 * The database sink: turn a finished pipeline run into a live article.
 *
 * This is what the cloud service does with every topic — save the article,
 * store the QA report next to it, and hand back the outcome to write onto the
 * topic row. No files are produced here; the .docx is a local-review tool and
 * has no part in an automated run (see lib/run-log.ts).
 *
 * WHERE AN ARTICLE LANDS
 *
 * AI articles go LIVE immediately — there is no human review step. The two
 * exceptions are articles the QA Agent itself would not stand behind:
 *   - a `reject` verdict, or
 *   - a QA run that crashed, and therefore checked nothing.
 * Those are saved as drafts (invisible to readers) and the topic is marked
 * `needs_human`, so they surface under "Needs human" at /admin/topics.
 *
 * `review: true` holds an entire run in the admin review queue instead, for a
 * cautious batch.
 *
 * Nothing on the site needs to be told about a new article: every route in the
 * Next.js app renders dynamically, so a published row is visible on the next
 * request.
 */
import type { ResearchVariant } from "../run-config";
import { errorText, type TopicRunResult } from "./run-topic";
import { saveArticle } from "./save-article";
import { saveQaReport } from "./save-qa-report";
import type { TopicOutcome, TopicRow } from "./topics-queue";

export interface PublishTopicInput {
  result: TopicRunResult;
  /** The queue row this run came from. Its `articleId` makes a re-run update. */
  row: TopicRow;
  variant: ResearchVariant;
  /** Save as `review` instead of publishing, for a cautious run. */
  review: boolean;
}

/** Where an article is saved, given what QA said about it. */
type SavedStatus = "published" | "review" | "draft";

/**
 * Save the run and return the outcome to record on the topic row.
 *
 * Never throws: a failure to save is reported as a `failed` outcome so the
 * drain loop records it and moves on to the next topic.
 */
export async function publishTopic(input: PublishTopicInput): Promise<TopicOutcome> {
  const { result, row, variant, review } = input;

  // ── Runs that produced nothing to save ──────────────────────────────────────
  // `articleId` is carried through on every outcome, including the failures.
  // finishTopic() writes whatever it is given, so omitting it on a failed re-run
  // would null out the link to the article an EARLIER run published — the
  // article would stay live with nothing on the queue pointing at it, and the
  // next re-run would create a duplicate instead of updating it.
  if (result.researchError) {
    return {
      status: "failed",
      researchVariant: variant,
      articleId: row.articleId,
      lastError: `Research Agent failed: ${result.researchError}`,
    };
  }

  if (result.needsHumanResearch) {
    return {
      status: "needs_human",
      researchVariant: variant,
      articleId: row.articleId,
      note: "No usable material found in approved sources; the Writing Agent was skipped.",
    };
  }

  if (result.writingError || !result.article) {
    return {
      status: "failed",
      researchVariant: variant,
      articleId: row.articleId,
      lastError: `Writing Agent failed: ${result.writingError ?? "no article produced"}`,
    };
  }

  // ── An article exists. Decide where it lands. ───────────────────────────────
  const qa = result.qa;
  const rejected = qa?.verdict === "reject";
  const unchecked = result.qaError !== null;

  const savedStatus: SavedStatus =
    rejected || unchecked ? "draft" : review ? "review" : "published";

  // QA's corrected article is the one worth keeping; fall back to the Writing
  // Agent's original when QA rejected it or never ran.
  const finalArticle = qa?.edited_article ?? result.article;

  const outcome: TopicOutcome = {
    status: rejected || unchecked ? "needs_human" : "done",
    researchVariant: variant,
    // Replaced by the id saveArticle() returns; kept here so a save that fails
    // leaves the previous run's article still linked (see the note above).
    articleId: row.articleId,
    qaVerdict: qa?.verdict ?? null,
    qaConfidence: qa?.confidence ?? null,
    qaIssueCount: qa?.issues?.length ?? null,
    qaSummary: qa?.summary ?? null,
    lastError: result.qaError ? `QA Agent failed: ${result.qaError}` : null,
  };

  try {
    const saved = await saveArticle({
      article: finalArticle,
      status: savedStatus,
      existingArticleId: row.articleId,
      editorNote:
        `AI pipeline — research (${variant}) → writing → QA` +
        (qa ? ` (verdict: ${qa.verdict})` : unchecked ? " (QA FAILED — unreviewed)" : ""),
    });
    outcome.articleId = saved.articleId;

    for (const warning of saved.warnings) console.warn(`[Publish]   note: ${warning}`);
    console.log(
      `[Publish] ${saved.created ? "Created" : "Updated"} article "${saved.slug}" ` +
        `(${saved.referenceCount} references, status: ${savedStatus})` +
        (savedStatus === "published" ? `  → live at /article/${saved.slug}` : "")
    );

    // Store the full report next to the article, for /admin/qa/<slug>. The
    // article is already committed at this point, so a failure here must not
    // turn a good run into a failed one — log it and carry on.
    if (qa) {
      try {
        await saveQaReport({
          articleId: saved.articleId,
          topicId: row.id,
          report: qa,
          researchVariant: variant,
          savedStatus,
        });
        console.log(`[Publish] QA report stored → /admin/qa/${saved.slug}`);
      } catch (err) {
        console.warn(`[Publish] Storing the QA report FAILED: ${errorText(err)}`);
      }
    }

    if (rejected) {
      outcome.note = "QA rejected this article — saved as a draft, NOT published.";
    } else if (unchecked) {
      outcome.note = "QA did not run — saved as an unchecked draft, NOT published.";
    } else if (saved.warnings.length > 0) {
      outcome.note = saved.warnings.join(" ");
    }
  } catch (err) {
    console.error(`[Publish] Saving "${row.topic}" to the database FAILED:`, err, "\n");
    outcome.status = "failed";
    outcome.lastError = `Database save failed: ${errorText(err)}`;
  }

  return outcome;
}
