// app/admin/topics/page.tsx
import { requireAdmin } from "@/lib/auth-guard";
import { db } from "@/db";
import { articles, topics } from "@/db/schema";
import { desc, asc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { addTopics, deleteTopic, retryTopic, skipTopic } from "./actions";

export const metadata = { title: "Topic queue" };

type Status = "pending" | "running" | "done" | "needs_human" | "failed" | "skipped";

/** What the table is showing: one status, everything, or the default digest. */
type View = Status | "all" | "activity";

/**
 * Rows per page. The queue routinely holds thousands of topics — rendering all
 * of them into one table is what made this page take ~10 seconds to open.
 */
const PAGE_SIZE = 50;

/**
 * The default view: every topic the pipeline has already touched. It exists to
 * keep the enormous `pending` bucket off the landing page — that bucket is a
 * work list for the worker, not something a human reads top to bottom.
 */
const ACTIVITY: Status[] = ["running", "failed", "needs_human", "done"];

const STATUS_LABELS: Record<Status, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  needs_human: "Needs human",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_STYLES: Record<Status, string> = {
  pending: "bg-brass/15 text-brass",
  running: "bg-azure/15 text-azure",
  done: "bg-emerald-500/15 text-emerald-700",
  needs_human: "bg-brass/25 text-brass",
  failed: "bg-[#b3261e]/15 text-[#b3261e]",
  skipped: "bg-hairline-strong/30 text-muted",
};

const ORDER = [
  "running",
  "pending",
  "failed",
  "needs_human",
  "done",
  "skipped",
] as const satisfies readonly Status[];

// Needs-attention first; the same order the status filter is listed in.
const STATUS_ORDER = sql`CASE ${topics.status}
  WHEN 'running' THEN 0
  WHEN 'pending' THEN 1
  WHEN 'failed' THEN 2
  WHEN 'needs_human' THEN 3
  WHEN 'done' THEN 4
  ELSE 5 END`;

function formatDate(d: Date | null) {
  return d ? new Date(d).toLocaleDateString() : "—";
}

/** A link to one view/page. Page 1 and the default view stay out of the URL. */
function hrefFor(view: View, page: number): string {
  const params = new URLSearchParams();
  if (view !== "activity") params.set("status", view);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/topics?${query}` : "/admin/topics";
}

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string; added?: string; skipped?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const view: View = ORDER.includes(params.status as Status)
    ? (params.status as Status)
    : params.status === "all"
      ? "all"
      : "activity";

  const requested = Number(params.page);
  const page = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;

  const where =
    view === "all"
      ? undefined
      : view === "activity"
        ? inArray(topics.status, ACTIVITY)
        : eq(topics.status, view);

  // The two queries are independent — one round trip to Neon instead of two.
  const [rows, counts] = await Promise.all([
    db
      .select({
        id: topics.id,
        topic: topics.topic,
        status: topics.status,
        priority: topics.priority,
        attempts: topics.attempts,
        lastError: topics.lastError,
        note: topics.note,
        qaVerdict: topics.qaVerdict,
        qaIssueCount: topics.qaIssueCount,
        qaSummary: topics.qaSummary,
        researchVariant: topics.researchVariant,
        createdAt: topics.createdAt,
        completedAt: topics.completedAt,
        articleSlug: articles.slug,
        articleStatus: articles.status,
      })
      .from(topics)
      .leftJoin(articles, eq(topics.articleId, articles.id))
      .where(where)
      // `id` last so the sort is total: without a unique tiebreaker two rows
      // with the same status/priority/created_at could swap places between
      // requests, hiding one from a page and showing another twice.
      .orderBy(STATUS_ORDER, desc(topics.priority), asc(topics.createdAt), asc(topics.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({ status: topics.status, n: sql<number>`count(*)::int` })
      .from(topics)
      .groupBy(topics.status),
  ]);

  const countFor = (s: Status) => counts.find((c) => c.status === s)?.n ?? 0;
  const total = counts.reduce((sum, c) => sum + c.n, 0);
  const activityTotal = ACTIVITY.reduce((sum, s) => sum + countFor(s), 0);
  // Every view's total comes out of that one GROUP BY — no extra COUNT query.
  const matching =
    view === "all" ? total : view === "activity" ? activityTotal : countFor(view);

  const pageCount = Math.max(1, Math.ceil(matching / PAGE_SIZE));
  const firstOnPage = (page - 1) * PAGE_SIZE + 1;
  const lastOnPage = firstOnPage + rows.length - 1;

  const viewLabel =
    view === "all"
      ? "topics"
      : view === "activity"
        ? "topics with activity"
        : `${STATUS_LABELS[view].toLowerCase()} topics`;

  const added = Number(params.added);
  const skippedCount = Number(params.skipped);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <span className="eyebrow">Editorial workspace</span>
        <h1 className="mt-1.5 font-display text-3xl font-bold text-ink">Topic queue</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] leading-relaxed text-muted">
          What the AI pipeline writes about. A run claims pending topics in priority order,
          researches, writes and fact-checks each one, then{" "}
          <strong className="font-semibold text-ink">publishes the article straight to the site</strong>.
          Anything the QA agent rejected or couldn&rsquo;t verify is held back as a draft and
          listed under <em>Needs human</em> below. Start a run with{" "}
          <code className="rounded bg-paper px-1 py-px text-sm">npm run research</code> in the
          worker folder.
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-faint">
          This view lists the topics the pipeline has already worked on. The full waiting list
          is under <em>Pending</em>.
        </p>
      </header>

      {Number.isFinite(added) && params.added !== undefined && (
        <p className="mb-5 rounded-lg border border-brass/40 bg-brass/10 px-4 py-3 text-sm text-ink">
          {added > 0
            ? `Added ${added} topic${added === 1 ? "" : "s"} to the queue.`
            : "No new topics were added."}
          {skippedCount > 0 && ` ${skippedCount} were already queued.`}
        </p>
      )}

      {/* Add topics */}
      <form action={addTopics} className="card mb-8 p-5">
        <h2 className="font-display text-lg font-bold text-ink">Add topics</h2>
        <p className="mt-1 text-sm text-muted">
          One per line. Lines starting with <code>#</code> are ignored, and topics already in
          the queue are skipped.
        </p>
        <textarea
          name="topics"
          rows={5}
          required
          placeholder={"Energy in Israel\nZvi Yehuda Kook\nMa'alot-Tarshiha"}
          className="input mt-3 font-mono text-sm"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted">
            Priority
            <input
              name="priority"
              type="number"
              defaultValue={0}
              className="input w-24"
              title="Higher priority topics are researched first."
            />
          </label>
          <button type="submit" className="btn btn-primary ml-auto">
            Add to queue
          </button>
        </div>
      </form>

      {/* Status filter */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Link
          href={hrefFor("activity", 1)}
          className={`chip ${view === "activity" ? "border-techelet text-techelet" : ""}`}
          title="Running, failed, needs human and done"
        >
          Activity ({activityTotal})
        </Link>
        <Link
          href={hrefFor("all", 1)}
          className={`chip ${view === "all" ? "border-techelet text-techelet" : ""}`}
        >
          All ({total})
        </Link>
        {ORDER.map((s) => (
          <Link
            key={s}
            href={hrefFor(s, 1)}
            className={`chip ${view === s ? "border-techelet text-techelet" : ""}`}
          >
            {STATUS_LABELS[s]} ({countFor(s)})
          </Link>
        ))}
      </div>

      {/* Queue table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline bg-paper/60 text-left">
              <th className="px-4 py-3 font-semibold text-muted">Topic</th>
              <th className="px-4 py-3 font-semibold text-muted">Status</th>
              <th className="hidden px-4 py-3 font-semibold text-muted md:table-cell">QA</th>
              <th className="hidden px-4 py-3 font-semibold text-muted sm:table-cell">Added</th>
              <th className="px-4 py-3 text-right font-semibold text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const status = t.status as Status;
              const detail = t.lastError ?? t.note;

              return (
                <tr key={t.id} className="border-b border-hairline last:border-0 align-top hover:bg-paper/50">
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-base font-semibold text-ink">{t.topic}</span>
                      {t.priority !== 0 && (
                        <span className="badge bg-paper text-muted" title="Priority">
                          p{t.priority}
                        </span>
                      )}
                      {t.attempts > 1 && (
                        <span className="text-xs text-faint" title="Pipeline attempts">
                          ×{t.attempts}
                        </span>
                      )}
                    </div>
                    {t.articleSlug && (
                      <Link
                        href={`/admin/edit/${t.articleSlug}`}
                        className="mt-1 inline-block text-sm font-medium text-azure hover:text-techelet"
                      >
                        → {t.articleStatus === "review" ? "Review draft" : `Article (${t.articleStatus})`}
                      </Link>
                    )}
                    {detail && (
                      <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{detail}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>
                    {t.researchVariant && (
                      <div className="mt-1 text-xs text-faint">{t.researchVariant}</div>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    {t.qaVerdict ? (
                      <>
                        <div className="font-medium text-ink">{t.qaVerdict.replace(/_/g, " ")}</div>
                        {t.qaIssueCount !== null && t.qaIssueCount > 0 && (
                          <div className="text-xs text-muted">
                            {t.qaIssueCount} unresolved issue{t.qaIssueCount === 1 ? "" : "s"}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-muted sm:table-cell">
                    {formatDate(t.completedAt ?? t.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    {/*
                      The topic id travels as a hidden field, NOT as a bound
                      argument (`retryTopic.bind(null, t.id)`). See the note on
                      `topicId()` in actions.ts — binding costs a full Flight
                      render per row and was the main reason this page hung.
                    */}
                    <div className="flex items-center justify-end gap-3">
                      {status !== "pending" && status !== "running" && (
                        <form action={retryTopic}>
                          <input type="hidden" name="id" value={t.id} />
                          <button type="submit" className="font-medium text-azure hover:text-techelet">
                            Re-queue
                          </button>
                        </form>
                      )}
                      {status === "pending" && (
                        <form action={skipTopic}>
                          <input type="hidden" name="id" value={t.id} />
                          <button type="submit" className="font-medium text-muted hover:text-ink">
                            Skip
                          </button>
                        </form>
                      )}
                      <form action={deleteTopic}>
                        <input type="hidden" name="id" value={t.id} />
                        <button
                          type="submit"
                          className="font-medium text-[#b3261e] transition-opacity hover:opacity-75"
                        >
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted">
                  {page > 1 ? (
                    <>
                      Nothing on page {page}.{" "}
                      <Link
                        href={hrefFor(view, 1)}
                        className="font-medium text-azure hover:text-techelet"
                      >
                        Back to the first page
                      </Link>
                    </>
                  ) : total === 0 ? (
                    "The queue is empty — add topics above, or import a list with `npm run topics:import`."
                  ) : (
                    `No ${viewLabel}.`
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      {matching > 0 && (
        <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted">
            {rows.length > 0
              ? `Showing ${firstOnPage}–${lastOnPage} of ${matching} ${viewLabel}`
              : `${matching} ${viewLabel}`}
          </p>
          {pageCount > 1 && (
            <div className="flex items-center gap-3">
              {page > 1 ? (
                <Link
                  href={hrefFor(view, page - 1)}
                  className="font-medium text-azure hover:text-techelet"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="text-faint">← Previous</span>
              )}
              <span className="text-muted">
                Page {Math.min(page, pageCount)} of {pageCount}
              </span>
              {page < pageCount ? (
                <Link
                  href={hrefFor(view, page + 1)}
                  className="font-medium text-azure hover:text-techelet"
                >
                  Next →
                </Link>
              ) : (
                <span className="text-faint">Next →</span>
              )}
            </div>
          )}
        </nav>
      )}
    </main>
  );
}
