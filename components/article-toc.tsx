"use client";

import { useEffect, useState } from "react";

export type TocItem = { id: string; label: string };

/**
 * The article's left rail. The active entry tracks the reader's position, so
 * the marker in the design means something rather than being decoration.
 */
export default function ArticleToc({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const targets = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    // Track every section's position rather than only the ones intersecting,
    // so short sections and fast scrolls still resolve to a sensible entry.
    const visible = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }

        if (visible.size > 0) {
          // The topmost visible section wins.
          const topmost = targets.find((t) => visible.has(t.id));
          if (topmost) setActiveId(topmost.id);
          return;
        }

        // Nothing intersecting (a section taller than the viewport): fall back
        // to the last section whose top has passed the reading line.
        const line = window.innerHeight * 0.3;
        let candidate = targets[0];
        for (const t of targets) {
          if (t.getBoundingClientRect().top <= line) candidate = t;
        }
        setActiveId(candidate.id);
      },
      { rootMargin: "-72px 0px -55% 0px", threshold: [0, 0.25, 1] },
    );

    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav className="ap-toc" aria-label="On this page">
      <ol>
        {items.map((item, i) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={`ap-toc-link${active ? " is-active" : ""}`}
                aria-current={active ? "true" : undefined}
              >
                <span className="ap-toc-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="ap-toc-label">{item.label}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
