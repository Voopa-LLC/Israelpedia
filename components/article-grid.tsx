"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { ArticleCard } from "@/app/actions/articles";

const PAGE_SIZE = 6;

/**
 * The home page's article grid. Used only by app/page.tsx, so its styling is
 * the home design's (.hp-* in globals.css).
 */
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
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((a) => (
          <li key={a.id}>
            <Link href={`/article/${a.slug}`} className="hp-card">
              {/* Only real categories get a chip — nothing is invented to fill
                  the slot, so cards without one simply start at the title. */}
              {a.category && <span className="hp-chip">{a.category}</span>}
              <h3 className={`hp-card-title ${a.category ? "mt-3" : ""}`}>{a.title}</h3>
              {a.summary && (
                <p className="hp-card-summary mt-2.5 line-clamp-4">{a.summary}</p>
              )}
            </Link>
          </li>
        ))}
      </ul>

      {(hasMore || canCollapse) && (
        <div className="mt-9 flex justify-center gap-3">
          {canCollapse && (
            <button onClick={showLess} className="hp-navlink">
              Show less
            </button>
          )}
          {hasMore && (
            <button onClick={loadMore} disabled={isPending} className="hp-btn">
              {isPending ? "Loading…" : "Show more articles"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
