/**
 * The topic queue: how a pipeline run gets its work.
 *
 * Replaces hand-editing src/manual-topics.ts. Topics live in the `topics`
 * table (see db/schema.ts); a run claims them one at a time and writes the
 * outcome back onto the row, so re-running the pipeline never repeats a topic
 * that already produced an article and you can see progress from the admin UI.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import { topics } from "../../../db/schema";
import type { ResearchInput, TopicCategory, SignificanceTier } from "../agents/research";
import { getDb } from "./db";

/** A claimed row, as Drizzle types it. */
export type TopicRow = typeof topics.$inferSelect;

/**
 * Atomically take the next pending topic and mark it `running`.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run twice at once: two
 * concurrent pipelines will each get a different topic instead of both grabbing
 * the same one. Returns null when the queue is empty.
 */
export async function claimNextTopic(): Promise<TopicRow | null> {
  const db = getDb();

  const claimed = await db.execute(sql`
    UPDATE topics SET
      status = 'running',
      attempts = attempts + 1,
      started_at = now(),
      updated_at = now(),
      last_error = NULL
    WHERE id = (
      SELECT id FROM topics
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);

  const row = (claimed as unknown as { id: string }[])[0];
  if (!row) return null;

  // Re-read through Drizzle so callers get the camelCased, typed row.
  const [full] = await db.select().from(topics).where(eq(topics.id, row.id));
  return full ?? null;
}

/** How many topics are still waiting. Used only for the run's opening log line. */
export async function countPending(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(topics)
    .where(eq(topics.status, "pending"));
  return row?.n ?? 0;
}

/**
 * Read pending topics WITHOUT claiming them.
 *
 * For inspection-only runs (`npm run research:only`), which must never consume
 * the queue — they produce no article, so a claimed row would be marked as
 * handled while nothing was actually written.
 */
export async function peekPendingTopics(limit: number): Promise<TopicRow[]> {
  return getDb()
    .select()
    .from(topics)
    .where(eq(topics.status, "pending"))
    .orderBy(desc(topics.priority), asc(topics.createdAt))
    .limit(limit);
}

/**
 * Put topics that a previous run left `running` back to `pending`.
 *
 * A crash (or Ctrl-C) leaves rows claimed forever otherwise. Only rows older
 * than `olderThanMinutes` are reset, so this can't steal a topic from a
 * pipeline that is genuinely still working on it.
 */
export async function requeueStale(olderThanMinutes = 90): Promise<number> {
  const db = getDb();
  const reset = await db.execute(sql`
    UPDATE topics SET status = 'pending', updated_at = now()
    WHERE status = 'running'
      AND started_at < now() - (${olderThanMinutes} * interval '1 minute')
    RETURNING id
  `);
  return (reset as unknown as unknown[]).length;
}

/** Hand a claimed topic back untouched (e.g. the run was interrupted). */
export async function releaseTopic(id: string): Promise<void> {
  await getDb()
    .update(topics)
    .set({ status: "pending", startedAt: null, updatedAt: new Date() })
    .where(eq(topics.id, id));
}

export interface TopicOutcome {
  status: "done" | "needs_human" | "failed";
  /** The article this run produced, when there is one. */
  articleId?: string | null;
  researchVariant?: string;
  qaVerdict?: string | null;
  qaConfidence?: number | null;
  qaIssueCount?: number | null;
  qaSummary?: string | null;
  note?: string | null;
  lastError?: string | null;
}

/** Record the result of a run on the topic row. */
export async function finishTopic(id: string, outcome: TopicOutcome): Promise<void> {
  await getDb()
    .update(topics)
    .set({
      status: outcome.status,
      articleId: outcome.articleId ?? null,
      researchVariant: outcome.researchVariant ?? null,
      qaVerdict: outcome.qaVerdict ?? null,
      qaConfidence: outcome.qaConfidence ?? null,
      qaIssueCount: outcome.qaIssueCount ?? null,
      qaSummary: outcome.qaSummary ?? null,
      note: outcome.note ?? null,
      lastError: outcome.lastError ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(topics.id, id));
}

/** A queue row as the Research Agent wants it. Null columns stay unset so the agent decides. */
export function toResearchInput(row: TopicRow): ResearchInput {
  const input: ResearchInput = { topic: row.topic };
  if (row.category) input.category = row.category as TopicCategory;
  if (row.aliases && row.aliases.length > 0) input.aliases = row.aliases;
  if (row.significanceTier) input.significance_tier = row.significanceTier as SignificanceTier;
  return input;
}
