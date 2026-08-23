// db/schema.ts
import {
  pgTable, uuid, text, timestamp, pgEnum, integer, index, uniqueIndex, doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRole = pgEnum("user_role", ["reader", "contributor", "admin"]);
export const articleStatus = pgEnum("article_status", ["draft", "review", "published", "archived"]);
export const suggestionStatus = pgEnum("suggestion_status", ["pending", "accepted", "rejected", "merged", "published"]);
export const articleOrigin = pgEnum("article_origin", ["human", "ai", "user_suggestion"]);

// --- Topic queue (the AI pipeline's work list) ---
// pending    → waiting to be picked up
// running    → claimed by a pipeline run right now
// done       → article produced and waiting in the admin review queue
// needs_human→ produced nothing usable (no research material, or QA rejected)
// failed     → a pipeline stage threw; see last_error
// skipped    → parked by an admin; never claimed
export const topicStatus = pgEnum("topic_status", [
  "pending", "running", "done", "needs_human", "failed", "skipped",
]);
// Mirrors TopicCategory in worker/src/agents/research.ts.
export const topicCategory = pgEnum("topic_category", ["person", "place", "event", "concept"]);
// Mirrors SignificanceTier in worker/src/agents/research.ts.
export const significanceTier = pgEnum("significance_tier", ["major", "standard"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  role: userRole("role").notNull().default("reader"),
  hashedPassword: text("hashed_password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const articles = pgTable("articles", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  // English (canonical source language)
  title: text("title").notNull(),
  summary: text("summary"),
  body: text("body").notNull(),
  // Hebrew translation — populated by the drafting agent after the English draft
  titleHe: text("title_he"),
  summaryHe: text("summary_he"),
  bodyHe: text("body_he"),
  status: articleStatus("status").notNull().default("draft"),
  origin: articleOrigin("origin").notNull().default("human"),
  category: text("category"),
  createdBy: uuid("created_by").references(() => users.id),
  viewCount: integer("view_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),
}, (t) => ({
  statusIdx: index("articles_status_idx").on(t.status),
  ftsIdx: index("articles_fts_idx")
    .using("gin", sql`to_tsvector('english', ${t.title} || ' ' || coalesce(${t.body}, ''))`),
}));

export const articleRevisions = pgTable("article_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  summary: text("summary"),
  body: text("body").notNull(),
  titleHe: text("title_he"),
  summaryHe: text("summary_he"),
  bodyHe: text("body_he"),
  editedBy: uuid("edited_by").references(() => users.id),
  editorNote: text("editor_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const suggestions = pgTable("suggestions", {
  id: uuid("id").defaultRandom().primaryKey(),
  topic: text("topic").notNull(),
  rationale: text("rationale"),
  suggestedBy: uuid("suggested_by").references(() => users.id),
  status: suggestionStatus("status").notNull().default("pending"),
  reviewNote: text("review_note"),
  category: text("category"),
  articleId: uuid("article_id").references(() => articles.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const articleReferences = pgTable("article_references", {
  id: uuid("id").defaultRandom().primaryKey(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  url: text("url"),
  title: text("title"),
  sourceName: text("source_name"),
  accessedAt: timestamp("accessed_at"),
  // Footnote number as it appears in the body ([1], [2], ...). Set by the AI
  // pipeline so the inline markers match this list; null for older/handwritten
  // rows, which fall back to insert order.
  ordinal: integer("ordinal"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  articleIdx: index("article_references_article_idx").on(t.articleId, t.ordinal),
}));

/**
 * The AI pipeline's work queue: every topic we want an article about.
 *
 * Deliberately separate from `suggestions`. Suggestions are what readers ask
 * for and an admin triages by hand; topics are what the worker actually runs.
 * Accepting a suggestion can later enqueue a topic here, but nothing does that
 * automatically yet.
 *
 * The optional columns mirror ResearchInput in worker/src/agents/research.ts —
 * leave them null and the Research Agent classifies the topic itself.
 */
export const topics = pgTable("topics", {
  id: uuid("id").defaultRandom().primaryKey(),
  topic: text("topic").notNull(),
  category: topicCategory("category"),
  aliases: text("aliases").array(),
  significanceTier: significanceTier("significance_tier"),
  /** Higher runs first. Same priority → oldest first. */
  priority: integer("priority").notNull().default(0),
  status: topicStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  note: text("note"),
  /** Which research agent produced the last run: perplexity | claude | gpt. */
  researchVariant: text("research_variant"),
  // --- Results of the last completed run ---
  articleId: uuid("article_id").references(() => articles.id, { onDelete: "set null" }),
  qaVerdict: text("qa_verdict"),
  qaConfidence: doublePrecision("qa_confidence"),
  qaIssueCount: integer("qa_issue_count"),
  qaSummary: text("qa_summary"),
  addedBy: uuid("added_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (t) => ({
  // The claim query: pending topics, best priority first.
  queueIdx: index("topics_queue_idx").on(t.status, t.priority, t.createdAt),
  // Case-insensitive uniqueness so a bulk re-import can't duplicate a topic.
  topicUniqueIdx: uniqueIndex("topics_topic_unique_idx").on(sql`lower(${t.topic})`),
}));
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --- Auth.js tables ---
import { primaryKey } from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const accounts = pgTable("accounts", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").$type<AdapterAccountType>().notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: integer("expires_at"),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
}, (account) => ({
  compoundKey: primaryKey({ columns: [account.provider, account.providerAccountId] }),
}));

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expires: timestamp("expires", { mode: "date" }).notNull(),
}, (vt) => ({
  compoundKey: primaryKey({ columns: [vt.identifier, vt.token] }),
}));