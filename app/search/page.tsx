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
    <main className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
      <div className="mb-7 flex items-end justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <span className="eyebrow">Search results</span>
          <h1 className="mt-1.5 font-display text-2xl font-bold text-ink">
            {query ? (
              <>
                {count} result{count !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
              </>
            ) : (
              "Search"
            )}
          </h1>
        </div>
        {query && (
          <Link href="/" className="btn btn-ghost shrink-0">
            Clear search
          </Link>
        )}
      </div>

      {results.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {results.map((a) => (
            <li key={a.id}>
              <Link
                href={`/article/${a.slug}`}
                className="group flex h-full flex-col rounded-xl border border-hairline bg-card p-6 transition-all hover:border-techelet hover:shadow-[0_2px_20px_-8px_rgba(27,59,107,0.25)]"
              >
                <h2 className="font-display text-xl font-bold leading-snug text-ink transition-colors group-hover:text-techelet">
                  {a.title}
                </h2>
                {a.summary && (
                  <p className="mt-2 line-clamp-3 flex-1 text-[0.95rem] leading-relaxed text-muted">
                    {a.summary}
                  </p>
                )}
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-azure">
                  Read article
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : query ? (
        <div className="rounded-xl border border-dashed border-hairline-strong bg-card/50 px-6 py-16 text-center">
          <p className="font-display text-xl text-ink">
            No articles match &ldquo;{query}&rdquo;.
          </p>
          <p className="mt-2 text-muted">
            Try a different term, or{" "}
            <Link href="/suggest" className="link">
              suggest this topic
            </Link>{" "}
            for our editors.
          </p>
          <Link href="/" className="btn btn-secondary mt-6 inline-flex">
            Browse all articles
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-hairline-strong bg-card/50 px-6 py-16 text-center">
          <p className="font-display text-xl text-ink">Enter a search term above.</p>
        </div>
      )}
    </main>
  );
}
