import { searchArticles } from "@/lib/search";
import Link from "next/link";
import type { Metadata } from "next";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `Search: ${q}` : "Search" };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const results = query ? await searchArticles(query) : [];
  const count = results.length;

  return (
    <main className="sr-page">
      <div className="hp-shell py-12 sm:py-14">
        <p className="hp-eyebrow">Search Results</p>

        {/* The query is the headline — it is what the reader is looking at. */}
        <h1 className="hp-heading mt-2 break-words">
          {query ? `“${query}”` : "Search"}
        </h1>

        {query && (
          <div className="sr-meta">
            <span>
              {count} {count === 1 ? "result" : "results"}
            </span>
            <span aria-hidden="true">·</span>
            <Link href="/" className="sr-clear">
              Clear search
            </Link>
          </div>
        )}

        <hr className="sr-rule" />

        {results.length > 0 ? (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {results.map((a) => (
              <li key={a.id}>
                <Link href={`/article/${a.slug}`} className="hp-card">
                  {a.category && <span className="hp-chip">{a.category}</span>}
                  <h2 className={`hp-card-title ${a.category ? "mt-3" : ""}`}>
                    {a.title}
                  </h2>
                  {a.summary && (
                    <p className="hp-card-summary mt-2.5 line-clamp-4">{a.summary}</p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        ) : query ? (
          <div className="sr-empty">
            <p className="sr-empty-title">No articles match “{query}”.</p>
            <p className="sr-empty-body">
              Try a different term, or{" "}
              <Link href="/suggest" className="sr-empty-link">
                suggest this topic
              </Link>{" "}
              for our editors.
            </p>
            <Link href="/" className="hp-btn mt-6 inline-flex">
              Browse all articles
            </Link>
          </div>
        ) : (
          <div className="sr-empty">
            <p className="sr-empty-title">Search IsraelPedia.</p>
            <p className="sr-empty-body">
              Use the field at the top of the page to look for an article,
              a person, or a place.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
