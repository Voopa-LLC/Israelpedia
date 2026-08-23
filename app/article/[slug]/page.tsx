import { db } from "@/db";
import { articles, articleReferences } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { archiveArticle } from "./actions";
import ArticleMarkdown from "@/components/article-markdown";

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

  const refs = await db
    .select()
    .from(articleReferences)
    .where(eq(articleReferences.articleId, article.id))
    // `ordinal` is the footnote number the AI pipeline wrote into the body, so
    // the list must follow it. Older/handwritten rows have none and fall back
    // to creation order.
    .orderBy(asc(articleReferences.ordinal), asc(articleReferences.createdAt));

  const archiveWithId = archiveArticle.bind(null, article.id);
  const published = formatDate(article.publishedAt);
  const updated = formatDate(article.updatedAt);

  return (
    <article className="mx-auto max-w-[44rem] px-4 py-10 sm:px-6 sm:py-14">
      {/* Breadcrumb */}
      <nav className="mb-8 text-sm" aria-label="Breadcrumb">
        <Link href="/" className="text-muted transition-colors hover:text-techelet">
          ← All articles
        </Link>
      </nav>

      {/* Admin notice for non-public articles */}
      {isAdmin && article.status !== "published" && (
        <div className="mb-6 rounded-lg border border-brass/40 bg-brass/10 px-4 py-3 text-sm text-ink">
          You’re viewing an unpublished article
          <span className="font-semibold"> ({STATUS_LABELS[article.status]})</span>.
          Readers can’t see this yet.
        </div>
      )}

      {/* ---------------------------------------------- Manuscript header */}
      <header>
        <div className="rule-brass mb-6 w-16" />
        <p className="eyebrow">Encyclopedia entry</p>
        <h1 className="mt-3 font-display text-4xl font-bold leading-[1.12] tracking-tight text-ink sm:text-[2.85rem]">
          {article.title}
        </h1>

        {article.summary && (
          <p className="mt-5 border-l-2 border-brass pl-4 font-serif text-xl leading-relaxed text-muted">
            {article.summary}
          </p>
        )}

        {/* Metadata + admin controls */}
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-hairline py-3 text-sm text-muted">
          {published ? (
            <span>Published {published}</span>
          ) : (
            <span>{STATUS_LABELS[article.status]}</span>
          )}
          {updated && published && updated !== published && (
            <>
              <span aria-hidden="true" className="text-hairline-strong">·</span>
              <span>Updated {updated}</span>
            </>
          )}
          {isAdmin && (
            <span className="ml-auto flex items-center gap-3">
              <Link
                href={`/admin/edit/${article.slug}`}
                className="font-semibold text-azure transition-colors hover:text-techelet"
              >
                Edit
              </Link>
              <span aria-hidden="true" className="text-hairline-strong">·</span>
              <form action={archiveWithId} className="inline">
                <button
                  type="submit"
                  className="font-semibold text-[#b3261e] transition-opacity hover:opacity-75"
                >
                  Archive
                </button>
              </form>
            </span>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------ Body */}
      <div className="mt-9">
        <ArticleMarkdown body={article.body} />
      </div>

      {/* ------------------------------------------------ References */}
      {refs.length > 0 && (
        <section className="mt-14 border-t border-hairline pt-8">
          <h2 className="eyebrow mb-5">
            <span className="h-px w-6 bg-brass" aria-hidden="true" />
            References
          </h2>
          <ol className="flex flex-col gap-3">
            {refs.map((r, i) => (
              <li key={r.id} className="flex gap-3 text-[0.95rem] leading-relaxed">
                <span className="mt-0.5 font-sans text-sm font-semibold text-brass tabular-nums">
                  {i + 1}.
                </span>
                <span className="text-muted">
                  {r.url ? (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link font-medium"
                    >
                      {r.title || r.url}
                    </a>
                  ) : (
                    <span className="font-medium text-ink">{r.title}</span>
                  )}
                  {r.sourceName && <span className="text-muted"> — {r.sourceName}</span>}
                  {r.accessedAt && (
                    <span className="text-faint">
                      {" "}(accessed {formatDate(r.accessedAt)})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Footer nav */}
      <div className="mt-14 border-t border-hairline pt-6">
        <Link href="/" className="btn btn-secondary">
          ← Back to all articles
        </Link>
      </div>
    </article>
  );
}
