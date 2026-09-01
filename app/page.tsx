import { db } from "@/db";
import { articles } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import ArticleGrid from "@/components/article-grid";
import { IpLockup } from "@/components/ip-logo";
import { fetchMoreArticles } from "@/app/actions/articles";

// Two rows of three, matching the grid the design is built around.
const INITIAL_SIZE = 6;

export default async function Home() {
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: articles.id,
        slug: articles.slug,
        title: articles.title,
        summary: articles.summary,
        category: articles.category,
      })
      .from(articles)
      .where(eq(articles.status, "published"))
      .orderBy(desc(articles.publishedAt))
      .limit(INITIAL_SIZE + 1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(articles)
      .where(eq(articles.status, "published")),
  ]);

  const initialArticles = rows.slice(0, INITIAL_SIZE);
  const initialHasMore = rows.length > INITIAL_SIZE;
  const total = totals[0]?.n ?? 0;

  return (
    <main>
      {/* ---------------------------------------------------------- Hero */}
      <section className="hp-hero">
        <div className="hp-shell relative">
          <div className="flex justify-end pt-6">
            <p className="hp-count">
              Total current articles · {total.toLocaleString("en-US")}
              <span className="hp-count-dot" aria-hidden="true" />
            </p>
          </div>

          <div className="flex flex-col items-center pb-24 pt-14 text-center sm:pb-32 sm:pt-20">
            <h1 className="hp-wordmark">
              <IpLockup />
            </h1>
            <p className="hp-tagline mt-3">
              The online encyclopedia of Israel &amp; the Jewish people
            </p>

            <form
              action="/search"
              method="get"
              role="search"
              className="mt-9 w-full max-w-xl"
            >
              <div className="hp-search">
                <svg
                  className="hp-search-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  type="search"
                  name="q"
                  className="hp-search-input"
                  placeholder="Search articles, people, places…"
                  aria-label="Search articles"
                />
                <button type="submit" className="hp-search-go" aria-label="Search">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 12h15M13 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ Articles */}
      <section className="hp-band">
        <div className="hp-shell py-14 sm:py-16">
          <p className="hp-eyebrow">Discover Articles</p>
          <h2 className="hp-heading mt-2 mb-8">Recently Published</h2>

          {initialArticles.length > 0 ? (
            <ArticleGrid
              initialArticles={initialArticles}
              initialHasMore={initialHasMore}
              fetchMore={fetchMoreArticles}
            />
          ) : (
            <div
              className="rounded-[0.7rem] border border-dashed px-6 py-16 text-center"
              style={{ borderColor: "var(--hp-border)", backgroundColor: "var(--hp-card)" }}
            >
              <p className="hp-card-title">The library is just getting started.</p>
              <p className="hp-card-summary mt-2">
                No articles have been published yet — check back soon.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
