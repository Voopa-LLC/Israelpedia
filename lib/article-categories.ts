/**
 * The category vocabulary shared by the admin forms and the AI pipeline.
 *
 * These are the values the Research Agent resolves (see TopicCategory in
 * worker/src/agents/research.ts) and that the worker writes into
 * `articles.category`. Keeping the admin forms on the same four means a
 * hand-written article and a generated one produce the same chip, and the
 * column stays filterable later.
 *
 * Stored lowercase — `.hp-chip` in app/globals.css title-cases them for
 * display, so the stored value is never rewritten.
 */
import type { topicCategory } from "@/db/schema";

export const ARTICLE_CATEGORIES = ["person", "place", "event", "concept"] as const;

export type ArticleCategory = (typeof ARTICLE_CATEGORIES)[number];

// Compile-time guard so this list and the `topic_category` Postgres enum cannot
// drift apart silently: adding a value to one without the other fails the build
// rather than showing up as a category the other half of the app rejects.
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
// The alias IS the assertion — it exists to be checked, never referenced.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _CategoriesMatchSchema = AssertTrue<
  AssertEqual<ArticleCategory, (typeof topicCategory)["enumValues"][number]>
>;

/** "person" → "Person". Every value is a single word, so this is exact. */
export function categoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Narrow whatever the form posted to a real category, or null.
 *
 * The column is free-text `text`, not the enum, so nothing at the database
 * level would reject a hand-crafted POST — this is the check that matters.
 * An empty selection is legitimate and means "no category".
 */
export function parseCategory(value: FormDataEntryValue | null): ArticleCategory | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (ARTICLE_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as ArticleCategory)
    : null;
}
