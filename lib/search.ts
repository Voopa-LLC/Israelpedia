import { db } from "@/db";
import { articles } from "@/db/schema";
import { and, eq, ilike, isNull, not, or, sql } from "drizzle-orm";

export interface SearchResult {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: string | null;
  titleHe: string | null;
  summaryHe: string | null;
  hasHebrew: boolean;
}

function isHebrewQuery(q: string): boolean {
  return /[֐-׿]/.test(q);
}

const resultCols = {
  id: articles.id,
  slug: articles.slug,
  title: articles.title,
  summary: articles.summary,
  // Carried so a result card can show the same chip as the home page.
  category: articles.category,
  titleHe: articles.titleHe,
  summaryHe: articles.summaryHe,
  hasHebrew: sql<boolean>`(${articles.bodyHe} IS NOT NULL)`,
};

export async function searchArticles(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const heQuery = isHebrewQuery(q);

  // ── English FTS (ranked) ──────────────────────────────────────────────────
  const enFts = await db
    .select(resultCols)
    .from(articles)
    .where(
      and(
        eq(articles.status, "published"),
        sql`to_tsvector('english', ${articles.title} || ' ' || coalesce(${articles.body}, '')) @@ plainto_tsquery('english', ${q})`
      )
    )
    .orderBy(
      sql`ts_rank(
        to_tsvector('english', ${articles.title} || ' ' || coalesce(${articles.body}, '')),
        plainto_tsquery('english', ${q})
      ) DESC`
    )
    .limit(20);

  // ── Hebrew FTS using 'simple' config (no stemming; appropriate for Hebrew) ─
  const heFts = await db
    .select(resultCols)
    .from(articles)
    .where(
      and(
        eq(articles.status, "published"),
        not(isNull(articles.bodyHe)),
        sql`to_tsvector('simple', coalesce(${articles.titleHe}, '') || ' ' || coalesce(${articles.bodyHe}, '')) @@ plainto_tsquery('simple', ${q})`
      )
    )
    .orderBy(
      sql`ts_rank(
        to_tsvector('simple', coalesce(${articles.titleHe}, '') || ' ' || coalesce(${articles.bodyHe}, '')),
        plainto_tsquery('simple', ${q})
      ) DESC`
    )
    .limit(20);

  // ── English ILIKE fallback (partial / fuzzy match) ────────────────────────
  const enIlike = await db
    .select(resultCols)
    .from(articles)
    .where(
      and(
        eq(articles.status, "published"),
        or(ilike(articles.title, `%${q}%`), ilike(articles.summary, `%${q}%`))
      )
    )
    .limit(10);

  // ── Hebrew ILIKE fallback ─────────────────────────────────────────────────
  const heIlike = await db
    .select(resultCols)
    .from(articles)
    .where(
      and(
        eq(articles.status, "published"),
        or(ilike(articles.titleHe, `%${q}%`), ilike(articles.summaryHe, `%${q}%`))
      )
    )
    .limit(10);

  // ── Merge & deduplicate ───────────────────────────────────────────────────
  // When the query is in Hebrew, surface Hebrew FTS results first.
  const ordered = heQuery
    ? [...heFts, ...enFts, ...heIlike, ...enIlike]
    : [...enFts, ...heFts, ...enIlike, ...heIlike];

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const r of ordered) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      results.push(r);
    }
  }
  return results;
}
