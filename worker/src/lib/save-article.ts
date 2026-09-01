/**
 * Save a finished article into the database as `origin: "ai"`. This is the step
 * that reconnects the worker to Neon.
 *
 * By decision (2026-08-23) AI articles PUBLISH IMMEDIATELY — they go live
 * without passing through the admin review queue. The exception is an article
 * the QA Agent rejected or could not check, which is saved as a draft; see the
 * caller in run-research.ts. `npm run research -- --review` restores the
 * review-first behaviour for a run.
 *
 * Follows the same rules the admin panel does (app/admin/actions.ts):
 *   - every write snapshots the previous state into `article_revisions`
 *   - references are replaced wholesale, not diffed
 *   - `published_at` is stamped on first publish and never overwritten after
 */
import { and, eq, ne } from "drizzle-orm";
import { articles, articleReferences, articleRevisions } from "../../../db/schema";
import type { WrittenArticle } from "../agents/writing";
import { getDb } from "./db";
import { renderArticle } from "./to-markdown";

export interface SaveArticleInput {
  article: WrittenArticle;
  /**
   * "published" goes live immediately (the default);
   * "review" puts it in the admin queue;
   * "draft" parks it out of sight (QA rejected, or QA never ran).
   */
  status: "published" | "review" | "draft";
  /** Goes into the revision row so the history explains where this came from. */
  editorNote: string;
  /** Set when this topic already produced an article — update it instead of duplicating. */
  existingArticleId?: string | null;
}

export interface SaveArticleResult {
  articleId: string;
  slug: string;
  created: boolean;
  referenceCount: number;
  warnings: string[];
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "article"
  );
}

/**
 * A slug nothing else is using. `articles.slug` is UNIQUE, so without this an
 * automated writer hitting an existing title would throw a raw Postgres
 * unique-violation mid-transaction.
 */
async function uniqueSlug(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  base: string,
  ignoreArticleId?: string | null
): Promise<string> {
  for (let n = 1; n < 200; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const clash = await tx
      .select({ id: articles.id })
      .from(articles)
      .where(
        ignoreArticleId
          ? and(eq(articles.slug, candidate), ne(articles.id, ignoreArticleId))
          : eq(articles.slug, candidate)
      );
    if (clash.length === 0) return candidate;
  }
  // 200 articles sharing one title is not a real scenario — fail loudly.
  throw new Error(`Could not find a free slug for "${base}".`);
}

export async function saveArticle(input: SaveArticleInput): Promise<SaveArticleResult> {
  const rendered = renderArticle(input.article);
  if (!rendered.body) {
    throw new Error(`Rendered article "${rendered.title}" has an empty body — refusing to save.`);
  }

  const db = getDb();

  return db.transaction(async (tx) => {
    // Does the article this topic produced last time still exist?
    const [existing] = input.existingArticleId
      ? await tx.select().from(articles).where(eq(articles.id, input.existingArticleId))
      : [];

    if (existing) {
      // Snapshot the state BEFORE this run, exactly like updateArticle() does.
      await tx.insert(articleRevisions).values({
        articleId: existing.id,
        title: existing.title,
        summary: existing.summary,
        body: existing.body,
        titleHe: existing.titleHe,
        summaryHe: existing.summaryHe,
        bodyHe: existing.bodyHe,
        editedBy: null,
        editorNote: input.editorNote,
      });

      // Keep the existing slug: it may already be linked to from elsewhere.
      await tx
        .update(articles)
        .set({
          title: rendered.title,
          summary: rendered.summary || null,
          body: rendered.body,
          status: input.status,
          // Re-runs refresh it too, so an article created before the category
          // was stored stops being null the next time its topic is processed.
          category: input.article.category,
          updatedAt: new Date(),
          // First publish stamps the date; a re-run keeps the original, so the
          // homepage ordering doesn't jump every time a topic is re-processed.
          publishedAt:
            input.status === "published" && !existing.publishedAt
              ? new Date()
              : existing.publishedAt,
        })
        .where(eq(articles.id, existing.id));

      await tx.delete(articleReferences).where(eq(articleReferences.articleId, existing.id));
      await insertReferences(tx, existing.id, rendered.references);

      return {
        articleId: existing.id,
        slug: existing.slug,
        created: false,
        referenceCount: rendered.references.length,
        warnings: rendered.warnings,
      };
    }

    const slug = await uniqueSlug(tx, slugify(rendered.title));

    const [created] = await tx
      .insert(articles)
      .values({
        slug,
        title: rendered.title,
        summary: rendered.summary || null,
        body: rendered.body,
        status: input.status,
        origin: "ai",
        // The category the Research Agent resolved (person/place/event/concept),
        // stored lowercase — which is exactly what the site's `.hp-chip` expects
        // and title-cases for display, so the stored value is never rewritten.
        // It also picks the Writing Agent's section template, so it is already
        // guaranteed to be one of those four: the bundle falls back to "concept"
        // and QA carries the original through unchanged.
        category: input.article.category,
        // No user created this; `createdBy` is nullable.
        createdBy: null,
        publishedAt: input.status === "published" ? new Date() : null,
      })
      .returning({ id: articles.id, slug: articles.slug });

    await tx.insert(articleRevisions).values({
      articleId: created.id,
      title: rendered.title,
      summary: rendered.summary || null,
      body: rendered.body,
      editedBy: null,
      editorNote: input.editorNote,
    });

    await insertReferences(tx, created.id, rendered.references);

    return {
      articleId: created.id,
      slug: created.slug,
      created: true,
      referenceCount: rendered.references.length,
      warnings: rendered.warnings,
    };
  });
}

async function insertReferences(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  articleId: string,
  references: ReturnType<typeof renderArticle>["references"]
): Promise<void> {
  if (references.length === 0) return;
  await tx.insert(articleReferences).values(
    references.map((ref) => ({
      articleId,
      url: ref.url,
      // The agents emit ONE label per reference ("Anti-Defamation League, Hamas
      // Backgrounder") — publisher and title already combined. The article page
      // renders `title — sourceName`, so filling both columns printed it twice.
      // It goes in `title`, which is what the page uses for the link text.
      title: ref.sourceName,
      sourceName: null,
      accessedAt: ref.accessedAt,
      ordinal: ref.ordinal,
    }))
  );
}
