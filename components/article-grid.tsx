"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { ArticleCard } from "@/app/actions/articles";

const PAGE_SIZE = 40;

export default function ArticleGrid({
  initialArticles,
  initialHasMore,
  fetchMore,
}: {
  initialArticles: ArticleCard[];
  initialHasMore: boolean;
  fetchMore: (offset: number, limit: number) => Promise<ArticleCard[]>;
}) {
  const [visible, setVisible] = useState(initialArticles);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isPending, startTransition] = useTransition();

  const canCollapse = visible.length > initialArticles.length;

  function loadMore() {
    startTransition(async () => {
      const next = await fetchMore(visible.length, PAGE_SIZE);
      setVisible((prev) => [...prev, ...next]);
      if (next.length < PAGE_SIZE) setHasMore(false);
    });
  }

  function showLess() {
    setVisible(initialArticles);
    setHasMore(initialHasMore);
  }

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2">
        {visible.map((a) => (
          <li key={a.id}>
            <Link
              href={`/article/${a.slug}`}
              className="group flex h-full flex-col rounded-xl border border-hairline bg-card p-6 transition-all hover:border-techelet hover:shadow-[0_2px_20px_-8px_rgba(27,59,107,0.25)]"
            >
              <h3 className="font-display text-xl font-bold leading-snug text-ink transition-colors group-hover:text-techelet">
                {a.title}
              </h3>
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

      {(hasMore || canCollapse) && (
        <div className="mt-8 flex justify-center gap-3">
          {canCollapse && (
            <button onClick={showLess} className="btn btn-ghost">
              Show less
            </button>
          )}
          {hasMore && (
            <button onClick={loadMore} disabled={isPending} className="btn btn-secondary">
              {isPending ? "Loading…" : "Show more articles"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
