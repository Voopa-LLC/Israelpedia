// app/admin/page.tsx
import { requireAdmin } from "@/lib/auth-guard";
import { db } from "@/db";
import { articleQaReports, articles, suggestions, users } from "@/db/schema";
import { eq, desc, ilike, sql } from "drizzle-orm";
import Link from "next/link";
import { acceptSuggestion, rejectSuggestion } from "./actions";
import StatusControl from "./status-control";

// Sort order in the admin list: needs-attention first, archived last.
const STATUS_ORDER = sql`CASE ${articles.status}
  WHEN 'review' THEN 0
  WHEN 'draft' THEN 1
  WHEN 'published' THEN 2
  WHEN 'archived' THEN 3
  ELSE 4 END`;

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdmin();
  const { q } = await searchParams;
  const query = q?.trim();

  const allArticles = await db
    .select()
    .from(articles)
    .where(query ? ilike(articles.title, `%${query}%`) : undefined)
    .orderBy(STATUS_ORDER, desc(articles.updatedAt));

  /**
   * Which articles have a stored QA report, and what the newest one says.
   *
   * Only articles the pipeline produced AFTER `article_qa_reports` existed have
   * a row here — nothing was backfilled — so the "QA report" action is a link
   * for those and inert text for the rest. Reports are few and the columns are
   * narrow (the jsonb bodies are deliberately left out), so one ordered read
   * and a map beats a correlated subquery per row.
   */
  const qaReports = await db
    .select({
      articleId: articleQaReports.articleId,
      verdict: articleQaReports.verdict,
      changeCount: articleQaReports.changeCount,
      issueCount: articleQaReports.issueCount,
      createdAt: articleQaReports.createdAt,
    })
    .from(articleQaReports)
    .orderBy(desc(articleQaReports.createdAt));

  const latestQa = new Map<string, (typeof qaReports)[number]>();
  // Newest first, so the first row seen for an article is the one to show.
  for (const r of qaReports) if (!latestQa.has(r.articleId)) latestQa.set(r.articleId, r);

  const pendingSuggestions = await db
    .select({
      id: suggestions.id,
      topic: suggestions.topic,
      rationale: suggestions.rationale,
      createdAt: suggestions.createdAt,
      submitterEmail: users.email,
    })
    .from(suggestions)
    .leftJoin(users, eq(suggestions.suggestedBy, users.id))
    .where(eq(suggestions.status, "pending"))
    .orderBy(suggestions.createdAt);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <span className="eyebrow">Editorial workspace</span>
        <h1 className="mt-1.5 font-display text-3xl font-bold text-ink">Articles</h1>
      </header>

      {/* Toolbar */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link href="/admin/new" className="btn btn-primary">
          <span aria-hidden="true">+</span> New article
        </Link>
        <a href="#suggestions" className="text-xs text-muted hover:text-ink transition-colors">
          ↓ Suggestions ({pendingSuggestions.length})
        </a>
        <form method="get" role="search" className="relative ml-auto w-full max-w-xs">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            name="q"
            type="search"
            defaultValue={query ?? ""}
            placeholder="Search articles…"
            className="input !pl-9"
          />
        </form>
      </div>

      {query && (
        <p className="mb-3 text-sm text-muted">
          {allArticles.length === 0
            ? `No articles matching “${query}”.`
            : `${allArticles.length} article${allArticles.length === 1 ? "" : "s"} matching “${query}”.`}
          {" "}
          <Link href="/admin" className="link">Clear</Link>
        </p>
      )}

      {/* Articles table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline bg-paper/60 text-left">
              <th className="px-4 py-3 font-semibold text-muted">Title</th>
              <th className="px-4 py-3 font-semibold text-muted">Status</th>
              <th className="hidden px-4 py-3 font-semibold text-muted sm:table-cell">Updated</th>
              <th className="px-4 py-3 text-right font-semibold text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {allArticles.map((a) => {
              const qa = latestQa.get(a.id);
              return (
                <tr key={a.id} className="border-b border-hairline last:border-0 hover:bg-paper/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/article/${a.slug}`}
                        className="font-display text-base font-semibold text-ink hover:text-techelet"
                      >
                        {a.title}
                      </Link>
                      <span
                        title={a.bodyHe ? "Has Hebrew version" : "No Hebrew version yet"}
                        className={`shrink-0 rounded px-1 py-px text-[0.65rem] font-bold tracking-wide ${
                          a.bodyHe ? "text-brass" : "text-faint"
                        }`}
                      >
                        HE
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusControl articleId={a.id} status={a.status} />
                  </td>
                  <td className="hidden px-4 py-3 text-muted sm:table-cell">
                    {new Date(a.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/admin/edit/${a.slug}`}
                        className="font-medium text-azure hover:text-techelet"
                      >
                        Edit
                      </Link>
                      <span className="text-faint" aria-hidden="true">·</span>
                      {qa ? (
                        <Link
                          href={`/admin/qa/${a.slug}`}
                          title={
                            `QA verdict: ${qa.verdict.replace(/_/g, " ")} · ` +
                            `${qa.changeCount} change${qa.changeCount === 1 ? "" : "s"}, ` +
                            `${qa.issueCount} issue${qa.issueCount === 1 ? "" : "s"} · ` +
                            new Date(qa.createdAt).toLocaleDateString()
                          }
                          className="font-medium whitespace-nowrap text-azure hover:text-techelet"
                        >
                          QA report
                        </Link>
                      ) : (
                        <span
                          title="No QA report stored for this article."
                          className="font-medium whitespace-nowrap text-faint"
                        >
                          QA report
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {allArticles.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted">
                  {query ? "No matching articles." : "No articles yet — create your first one."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Suggestions queue */}
      <section id="suggestions" className="mt-12">
        <div className="mb-5 flex items-center gap-3 border-b border-hairline pb-3">
          <h2 className="font-display text-2xl font-bold text-ink">Pending suggestions</h2>
          <span className="badge bg-brass/15 text-brass">{pendingSuggestions.length}</span>
        </div>

        {pendingSuggestions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-hairline-strong bg-card/50 px-4 py-8 text-center text-muted">
            No pending suggestions right now.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {pendingSuggestions.map((s) => {
              const doAccept = acceptSuggestion.bind(null, s.id);
              const doReject = rejectSuggestion.bind(null, s.id);
              return (
                <div key={s.id} className="card p-5">
                  <h3 className="font-display text-lg font-bold text-ink">{s.topic}</h3>
                  {s.rationale && (
                    <p className="mt-1.5 text-[0.95rem] leading-relaxed text-muted">{s.rationale}</p>
                  )}
                  <p className="mt-2 text-xs text-faint">
                    {s.submitterEmail ?? "anonymous"} · {new Date(s.createdAt).toLocaleDateString()}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
                    <form action={doAccept}>
                      <button type="submit" className="btn btn-primary">
                        Accept &amp; draft
                      </button>
                    </form>
                    <form action={doReject} className="flex flex-1 items-center gap-2">
                      <input
                        name="reviewNote"
                        required
                        placeholder="Reason for rejecting…"
                        className="input"
                      />
                      <button type="submit" className="btn btn-danger shrink-0">
                        Reject
                      </button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
