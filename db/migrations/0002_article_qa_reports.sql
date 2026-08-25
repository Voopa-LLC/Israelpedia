-- 0002_article_qa_reports.sql
--
-- Adds `article_qa_reports`: the QA Agent's full report for one pipeline run —
-- verdict, confidence, summary, the changes it applied and the issues it left
-- unresolved. Matches db/schema.ts as of 2026-08-25.
--
-- Written by hand for the same reason 0001 was: `drizzle-kit push` exits
-- silently while introspecting this database. Every statement is additive and
-- idempotent — nothing is dropped, renamed or truncated, and re-running it is a
-- no-op. It backfills nothing; older articles simply have no report row.
--
-- Run it in the Neon SQL editor, or with:  npm run db:migrate-qa-reports

CREATE TABLE IF NOT EXISTS "article_qa_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "article_id" uuid NOT NULL,
  "topic_id" uuid,
  "verdict" text NOT NULL,
  "reject_target" text,
  "confidence" double precision,
  "summary" text,
  "changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "change_count" integer DEFAULT 0 NOT NULL,
  "issue_count" integer DEFAULT 0 NOT NULL,
  "research_variant" text,
  "saved_status" "article_status",
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Deleting an article takes its reports with it; the report is about that
-- article and means nothing without it.
DO $$ BEGIN
  ALTER TABLE "article_qa_reports"
    ADD CONSTRAINT "article_qa_reports_article_id_articles_id_fk"
    FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Deleting a queue row only loses the provenance link, never the report.
DO $$ BEGIN
  ALTER TABLE "article_qa_reports"
    ADD CONSTRAINT "article_qa_reports_topic_id_topics_id_fk"
    FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The page query: every report for one article, newest first.
CREATE INDEX IF NOT EXISTS "article_qa_reports_article_idx"
  ON "article_qa_reports" ("article_id", "created_at");
