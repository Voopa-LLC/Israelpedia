import { requireAdmin } from "@/lib/auth-guard";
import { db } from "@/db";
import { articles, articleReferences } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import ArticleEditForm from "./article-edit-form";

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireAdmin();
  const { slug } = await params;

  const [article] = await db.select().from(articles).where(eq(articles.slug, slug));
  if (!article) notFound();

  const refs = await db
    .select()
    .from(articleReferences)
    .where(eq(articleReferences.articleId, article.id))
    // `ordinal` is the footnote number the AI pipeline wrote into the body, so
    // the list must follow it. Older/handwritten rows have none and fall back
    // to creation order.
    .orderBy(asc(articleReferences.ordinal), asc(articleReferences.createdAt));

  const initialRefs = refs.map((r) => ({
    url: r.url ?? "",
    title: r.title ?? "",
    source: r.sourceName ?? "",
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <nav className="mb-6 text-sm" aria-label="Breadcrumb">
        <Link href="/admin" className="text-muted transition-colors hover:text-techelet">
          ← Back to articles
        </Link>
      </nav>
      <header className="mb-8">
        <span className="eyebrow">Editing</span>
        <h1 className="mt-1.5 font-display text-3xl font-bold text-ink">{article.title}</h1>
      </header>
      <ArticleEditForm
        article={{
          id: article.id,
          slug: article.slug,
          title: article.title,
          summary: article.summary ?? "",
          body: article.body,
          titleHe: article.titleHe ?? "",
          summaryHe: article.summaryHe ?? "",
          bodyHe: article.bodyHe ?? "",
          status: article.status,
          category: article.category ?? "",
        }}
        initialRefs={initialRefs}
      />
    </main>
  );
}
