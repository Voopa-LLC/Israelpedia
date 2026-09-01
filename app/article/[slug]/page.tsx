import { db } from "@/db";
import { articles, articleReferences } from "@/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { auth } from "@/auth";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { archiveArticle } from "./actions";
import ArticleMarkdown from "@/components/article-markdown";
import ArticleToc, { type TocItem } from "@/components/article-toc";
import BackToTop from "@/components/back-to-top";
import { splitIntoSections, pad2 } from "@/lib/article-sections";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  review: "In review",
  published: "Published",
  archived: "Archived",
};

async function getArticle(slug: string) {
  const [article] = await db.select().from(articles).where(eq(articles.slug, slug));
  return article;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticle(slug);
  if (!article) return { title: "Article not found" };
  return {
    title: article.title,
    description: article.summary ?? undefined,
  };
}

function formatDate(d: Date | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let session = null;
  try { session = await auth(); } catch {}
  const isAdmin = (session?.user as any)?.role === "admin";

  const article = await getArticle(slug);

  if (!article || article.status === "archived") notFound();
  if (article.status !== "published" && !isAdmin) notFound();

  const [refs, totals] = await Promise.all([
    db
      .select()
      .from(articleReferences)
      .where(eq(articleReferences.articleId, article.id))
      // `ordinal` is the footnote number the AI pipeline wrote into the body, so
      // the list must follow it. Older/handwritten rows have none and fall back
      // to creation order.
      .orderBy(asc(articleReferences.ordinal), asc(articleReferences.createdAt)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(articles)
      .where(eq(articles.status, "published")),
  ]);

  const totalArticles = totals[0]?.n ?? 0;
  const archiveWithId = archiveArticle.bind(null, article.id);
  const published = formatDate(article.publishedAt);
  const updated = formatDate(article.updatedAt);

  const { intro, sections } = splitIntoSections(article.body);

  // Section 01 is the summary — "In brief" in the design. Body headings follow,
  // and the source list closes the article.
  const hasBrief = !!article.summary || !!intro;
  const toc: TocItem[] = [
    ...(hasBrief ? [{ id: "in-brief", label: "In brief" }] : []),
    ...sections.map((s) => ({ id: s.id, label: s.title })),
    ...(refs.length > 0 ? [{ id: "sources", label: "Sources" }] : []),
  ];

  let n = 0;

  return (
    <main className="ap-page">
      <div className="ap-shell">
        {/* ------------------------------------------------------- Masthead */}
        <div className="flex items-center justify-between gap-4 pt-6">
          <Link href="/" className="ap-back">
            ← All articles
          </Link>
          <p className="hp-count">
            Total current articles · {totalArticles.toLocaleString("en-US")}
            <span className="hp-count-dot" aria-hidden="true" />
          </p>
        </div>

        {isAdmin && article.status !== "published" && (
          <div className="ap-notice">
            You’re viewing an unpublished article
            <span className="font-semibold"> ({STATUS_LABELS[article.status]})</span>.
            Readers can’t see this yet.
          </div>
        )}

        <h1 className="ap-title">{article.title}</h1>

        <div className="ap-meta">
          {published ? (
            <span>Published {published}</span>
          ) : (
            <span>{STATUS_LABELS[article.status]}</span>
          )}
          {updated && published && updated !== published && (
            <>
              <span aria-hidden="true">·</span>
              <span>Updated {updated}</span>
            </>
          )}
          {isAdmin && (
            <span className="ml-auto flex items-center gap-3">
              <Link href={`/admin/edit/${article.slug}`} className="ap-admin-link">
                Edit
              </Link>
              <span aria-hidden="true">·</span>
              <form action={archiveWithId} className="inline">
                <button type="submit" className="ap-admin-link ap-admin-danger">
                  Archive
                </button>
              </form>
            </span>
          )}
        </div>

        <hr className="ap-rule" />

        {/* ---------------------------------------------------------- Body */}
        <div className="ap-grid">
          <div className="ap-rail">
            <div className="ap-rail-inner">
              <ArticleToc items={toc} />
            </div>
          </div>

          <article className="ap-col">
            {hasBrief && (
              <section id="in-brief" className="ap-section">
                <h2 className="ap-section-head">
                  <span className="ap-section-num">{pad2(++n)}</span>
                  <span aria-hidden="true" className="ap-section-slash">/</span>
                  In brief
                </h2>
                {article.summary && <p className="ap-lead">{article.summary}</p>}
                {intro && (
                  <ArticleMarkdown body={intro} className="ap-prose" dropcap={false} />
                )}
              </section>
            )}

            {sections.map((s) => (
              <section key={s.id} id={s.id} className="ap-section">
                <h2 className="ap-section-head">
                  <span className="ap-section-num">{pad2(++n)}</span>
                  <span aria-hidden="true" className="ap-section-slash">/</span>
                  {s.title}
                </h2>
                <ArticleMarkdown body={s.content} className="ap-prose" dropcap={false} />
              </section>
            ))}

          </article>

          {/* Right rail. Deliberately empty: "Related content" has no data
              behind it yet, so the column reserves its place in the grid
              rather than inventing links. Drop the list in here. */}
          <div className="ap-rail ap-rail-right" aria-hidden="true" />
        </div>

        {/* Sources sit outside the three-column grid, running from the page's
            left margin rather than indented under the body column. */}
        {refs.length > 0 && (
          <section id="sources" className="ap-sources">
            <h2 className="ap-sources-head">Sources</h2>
            <ol className="ap-sources-list">
              {refs.map((r, i) => (
                <li key={r.id}>
                  <span className="ap-sources-num">{r.ordinal ?? i + 1}</span>
                  <span>
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ap-sources-link"
                      >
                        {r.title || r.url}
                      </a>
                    ) : (
                      <span>{r.title}</span>
                    )}
                    {r.sourceName && <span> — {r.sourceName}</span>}
                    {r.accessedAt && (
                      <span className="ap-sources-date">
                        {" "}(accessed {formatDate(r.accessedAt)})
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <BackToTop />
    </main>
  );
}
