-- 0001_topics_queue.sql
--
-- Adds the AI pipeline's topic queue and the reference ordinal column.
-- Matches db/schema.ts as of 2026-08-23.
--
-- Written by hand because `drizzle-kit push` exits silently while introspecting
-- this database. Every statement is additive and idempotent — nothing is
-- dropped, renamed or truncated, and re-running it is a no-op.
--
-- Run it in the Neon SQL editor, or with:  npm run db:migrate-topics

-- ── Enums ───────────────────────────────────────────────────────────────────
-- Postgres has no CREATE TYPE IF NOT EXISTS, hence the guards.
DO $$ BEGIN
  CREATE TYPE "public"."topic_status" AS ENUM('pending', 'running', 'done', 'needs_human', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."topic_category" AS ENUM('person', 'place', 'event', 'concept');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."significance_tier" AS ENUM('major', 'standard');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── The topic queue ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "topics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "topic" text NOT NULL,
  "category" "topic_category",
  "aliases" text[],
  "significance_tier" "significance_tier",
  "priority" integer DEFAULT 0 NOT NULL,
  "status" "topic_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "note" text,
  "research_variant" text,
  "article_id" uuid,
  "qa_verdict" text,
  "qa_confidence" double precision,
  "qa_issue_count" integer,
  "qa_summary" text,
  "added_by" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "started_at" timestamp,
  "completed_at" timestamp
);

DO $$ BEGIN
  ALTER TABLE "topics" ADD CONSTRAINT "topics_article_id_articles_id_fk"
    FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "topics" ADD CONSTRAINT "topics_added_by_users_id_fk"
    FOREIGN KEY ("added_by") REFERENCES "public"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Claim query: pending topics, best priority first.
CREATE INDEX IF NOT EXISTS "topics_queue_idx"
  ON "topics" USING btree ("status", "priority", "created_at");

-- Case-insensitive uniqueness, so a re-import can't duplicate a topic.
CREATE UNIQUE INDEX IF NOT EXISTS "topics_topic_unique_idx"
  ON "topics" USING btree (lower("topic"));

-- ── Reference footnote numbers ──────────────────────────────────────────────
-- Nullable: existing hand-entered rows keep NULL and fall back to insert order.
ALTER TABLE "article_references" ADD COLUMN IF NOT EXISTS "ordinal" integer;

CREATE INDEX IF NOT EXISTS "article_references_article_idx"
  ON "article_references" USING btree ("article_id", "ordinal");
