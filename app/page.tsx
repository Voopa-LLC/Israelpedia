import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import Link from "next/link";
import ArticleGrid from "@/components/article-grid";
import { fetchMoreArticles } from "@/app/actions/articles";

const TOPICS = [
  "People",
  "History",
  "Religion",
  "Language",
  "Science",
  "Culture",
  "Communities",
];

const INITIAL_SIZE = 20;

export default async function Home() {
  const rows = await db
    .select({
      id: articles.id,
      slug: articles.slug,
      title: articles.title,
      summary: articles.summary,
    })
    .from(articles)
    .where(eq(articles.status, "published"))
    .orderBy(desc(articles.publishedAt))
    .limit(INITIAL_SIZE + 1);

  const initialArticles = rows.slice(0, INITIAL_SIZE);
  const initialHasMore = rows.length > INITIAL_SIZE;

  return (
    <main>
      {/* ---------------------------------------------------------- Hero */}
      <section className="border-b border-hairline bg-gradient-to-b from-card to-paper">
        <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <p className="eyebrow justify-center">
            <span className="h-px w-6 bg-brass" aria-hidden="true" />
            The sourced reference
            <span className="h-px w-6 bg-brass" aria-hidden="true" />
          </p>
          <h1 className="mt-5 font-display text-4xl font-bold leading-[1.1] tracking-tight text-ink sm:text-5xl">
            A trustworthy encyclopedia of{" "}
            <span className="text-techelet">Israel and the Jewish world</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">
            Deep, well-cited coverage of history, culture, religion, language,
            science, and the people and communities that shaped them.
          </p>

          {/* Search — the centerpiece */}
          <form action="/search" method="get" role="search" className="mx-auto mt-9 max-w-xl">
            <div className="relative">
              <svg
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faint"
                width="20" height="20" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                name="q"
                placeholder="Search articles, people, places…"
                aria-label="Search articles"
                className="w-full rounded-xl border border-hairline-strong bg-card py-4 pl-12 pr-28 text-base text-ink shadow-sm transition-shadow focus:outline-none focus:ring-2 focus:ring-azure"
              />
              <button
                type="submit"
                className="btn btn-primary absolute right-2 top-1/2 -translate-y-1/2"
              >
                Search
              </button>
            </div>
          </form>

          {/* Topic chips */}
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {TOPICS.map((t) => (
              <Link key={t} href={`/search?q=${encodeURIComponent(t)}`} className="chip">
                {t}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ Articles */}
      <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
        <div className="mb-7 flex items-end justify-between gap-4 border-b border-hairline pb-4">
          <div>
            <span className="eyebrow">From the library</span>
            <h2 className="mt-1.5 font-display text-2xl font-bold text-ink">
              Recently published
            </h2>
          </div>
        </div>

        {initialArticles.length > 0 ? (
          <ArticleGrid
            initialArticles={initialArticles}
            initialHasMore={initialHasMore}
            fetchMore={fetchMoreArticles}
          />
        ) : (
          <div className="rounded-xl border border-dashed border-hairline-strong bg-card/50 px-6 py-16 text-center">
            <p className="font-display text-xl text-ink">The library is just getting started.</p>
            <p className="mt-2 text-muted">
              No articles have been published yet — check back soon.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
