"use server";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export type ArticleCard = {
  id: string;
  slug: string;
  title: string | null;
  summary: string | null;
  category: string | null;
};

export async function fetchMoreArticles(offset: number, limit: number): Promise<ArticleCard[]> {
  return db
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
    .offset(offset)
    .limit(limit);
}
