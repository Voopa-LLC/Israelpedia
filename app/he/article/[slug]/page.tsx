import { db } from "@/db";
import { articles, articleReferences } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ArticleMarkdown from "@/components/article-markdown";

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
  if (!article) return { title: "מאמר לא נמצא" };
  return {
    title: article.titleHe ?? article.title,
    description: article.summaryHe ?? article.summary ?? undefined,
    alternates: {
      languages: { en: `/article/${slug}` },
    },
  };
}

function formatDateHe(d: Date | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString("he-IL", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function HebrewArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();
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

  const published = formatDateHe(article.publishedAt);
  const updated = formatDateHe(article.updatedAt);

  // Article exists but Hebrew translation isn't ready yet
  if (!article.bodyHe) {
    return (
      <article className="mx-auto max-w-[44rem] px-4 py-10 sm:px-6 sm:py-14">
        <nav className="mb-8 text-sm" aria-label="ניווט">
          <Link href="/he" className="text-muted transition-colors hover:text-techelet">
            → כל המאמרים
          </Link>
        </nav>

        <div className="rule-brass mb-6 w-16" />

        <h1 className="mt-3 font-display text-3xl font-bold leading-[1.2] text-ink sm:text-4xl">
          {article.titleHe ?? article.title}
        </h1>

        <div className="mt-10 rounded-xl border border-hairline bg-card px-6 py-10 text-center">
          <p className="font-display text-xl text-ink">
            תרגום מאמר זה לעברית טרם זמין.
          </p>
          <p className="mt-3 text-muted leading-relaxed">
            המאמר נמצא בתהליך תרגום ויפורסם בעברית בקרוב.
          </p>
          <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link
              href={`/article/${slug}`}
              className="btn btn-primary"
            >
              קריאה באנגלית
            </Link>
            <Link href="/he" className="btn btn-secondary">
              חזרה לדף הראשי
            </Link>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="mx-auto max-w-[44rem] px-4 py-10 sm:px-6 sm:py-14">
      {/* Breadcrumb */}
      <nav className="mb-8 text-sm" aria-label="ניווט">
        <Link href="/he" className="text-muted transition-colors hover:text-techelet">
          → כל המאמרים
        </Link>
      </nav>

      {/* ---------------------------------------------- Manuscript header */}
      <header>
        <div className="rule-brass mb-6 w-16" />
        <p className="eyebrow">ערך אנציקלופדי</p>
        <h1 className="mt-3 font-display text-4xl font-bold leading-[1.2] tracking-tight text-ink sm:text-[2.85rem]">
          {article.titleHe}
        </h1>

        {article.summaryHe && (
          <p className="mt-5 border-r-2 border-brass pr-4 font-serif text-xl leading-relaxed text-muted">
            {article.summaryHe}
          </p>
        )}

        {/* Metadata */}
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-hairline py-3 text-sm text-muted">
          {published ? (
            <span>פורסם {published}</span>
          ) : (
            <span>
              {{
                draft: "טיוטה",
                review: "בבדיקה",
                published: "פורסם",
                archived: "בארכיון",
              }[article.status] ?? article.status}
            </span>
          )}
          {updated && published && updated !== published && (
            <>
              <span aria-hidden="true" className="text-hairline-strong">·</span>
              <span>עודכן {updated}</span>
            </>
          )}
          {/* Link to English version */}
          <span className="mr-auto">
            <Link
              href={`/article/${slug}`}
              className="text-azure transition-colors hover:text-techelet"
            >
              English
            </Link>
          </span>
        </div>
      </header>

      {/* ------------------------------------------------------ Body */}
      <div className="mt-9">
        <ArticleMarkdown body={article.bodyHe} />
      </div>

      {/* ------------------------------------------------ References */}
      {refs.length > 0 && (
        <section className="mt-14 border-t border-hairline pt-8">
          <h2 className="eyebrow mb-5">
            <span className="h-px w-6 bg-brass" aria-hidden="true" />
            מקורות
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
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Footer nav */}
      <div className="mt-14 border-t border-hairline pt-6">
        <Link href="/he" className="btn btn-secondary">
          חזרה לכל המאמרים
        </Link>
      </div>
    </article>
  );
}
