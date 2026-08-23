@AGENTS.md
# IsraelPedia — Project Context

## What this is
IsraelPedia is an online encyclopedia focused on topics connected to Israel and
to Jewish history, culture, religion, language, science, notable people, and
communities worldwide. The goal is a genuinely high-quality, well-sourced,
trustworthy reference site — deep and comprehensive coverage of these subjects.

## Editorial principles (important)
- Articles must be accurate and well-sourced, with real citations.
- Encyclopedic, neutral tone. Coverage can be rich and celebratory where the
  subject genuinely warrants it, but conclusions are never fixed before the
  facts, and contested topics are represented accurately with sourcing.
- Credibility is the priority: it's what makes the site rank in search and get
  cited by other sources. Do not build features that fabricate sources or bias
  content regardless of facts.

## Who uses it (access model)
- Anyone (no account): can READ all published articles.
- Logged-in user (role: contributor): can additionally SUGGEST article topics.
- Admin (role: admin): can create, edit, delete/archive articles, and review
  the suggestion queue and AI-drafted articles.
- Only `/admin` routes require admin. Public reading requires nothing.
  Suggesting requires only being logged in (NOT admin).

## How the AI pipeline works
1. Topics we want articles about are queued in the `topics` table — added at
   `/admin/topics` or in bulk with `npm run topics:import`.
2. `npm run research` (in `worker/`) claims pending topics one at a time and
   runs three agents: Research → Writing → QA/fact-checking.
3. The finished article is saved to `articles` as origin="ai" and
   status="published" — it goes LIVE immediately, with its citations in
   `article_references`. There is no human review step. (Changed 2026-08-23;
   `npm run research -- --review` holds a run in the review queue instead.)
4. The one exception: an article the QA agent REJECTED, or one whose QA run
   failed, is saved as status="draft" and never reaches readers. It shows as
   "Needs human" at `/admin/topics`.
5. The outcome of each run — QA verdict, confidence, unresolved issue count —
   is written back onto the topic row.

The `suggestions` table and the site's "suggest a topic" feature are SEPARATE
from this and unchanged: readers propose topics, an admin triages them by hand.
No agent touches suggestions yet.

The AI pipeline runs as a SEPARATE worker service (not inside this Next.js app),
connected to the same database. Its scheduled cron is still disabled — runs are
triggered manually.

## Tech stack
- Next.js (App Router) + TypeScript
- Drizzle ORM → Neon Postgres (cloud)
- Auth.js v5 (NextAuth) with Google sign-in; Drizzle adapter
- Deployed on Vercel; database on Neon

## Key files
- `db/schema.ts` — all tables: users, articles, articleRevisions, suggestions,
  articleReferences, plus Auth.js tables (accounts, sessions, verificationTokens).
- `db/index.ts` — the `db` Drizzle client. Import this to query the database.
- `auth.ts` — exports `auth`, `signIn`, `signOut`, `handlers`. Use `auth()` to
  get the current session; `session.user.id` and `session.user.role` are available.
- `lib/auth-guard.ts` — `requireAdmin()` guards admin pages/actions.

## Article lifecycle
- status: draft → review → published → archived
- Deleting should ARCHIVE (set status="archived"), not hard-delete, so nothing
  is lost.
- AI articles are published directly by the pipeline (see above); human-written
  articles still move through the admin panel by hand.
- Every edit writes a snapshot row to `articleRevisions` (full edit history).
- origin: "human" | "ai" | "user_suggestion"

## Conventions
- Server-side auth checks always (never trust the client).
- Re-check auth inside server actions, not just on the page.
- Keep secrets in env vars only. Never commit `.env`.
- Show file diffs and let me review/test before large changes are finalized.
