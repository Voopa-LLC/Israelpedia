// app/admin/topics/page.tsx
import { requireAdmin } from "@/lib/auth-guard";
import { db } from "@/db";
import { articles, topics } from "@/db/schema";
import { desc, asc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { addTopics, deleteTopic, retryTopic, skipTopic } from "./actions";

export const metadata = { title: "Topic queue" };

type Status = "pending" | "running" | "done" | "needs_human" | "failed" | "skipped";

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

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; added?: string; skipped?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const filter = ORDER.includes(params.status as Status) ? (params.status as Status) : null;

  const rows = await db
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
    .where(filter ? eq(topics.status, filter) : undefined)
    .orderBy(STATUS_ORDER, desc(topics.priority), asc(topics.createdAt));

  const counts = await db
    .select({ status: topics.status, n: sql<number>`count(*)::int` })
    .from(topics)
    .groupBy(topics.status);
  const countFor = (s: Status) => counts.find((c) => c.status === s)?.n ?? 0;
  const total = counts.reduce((sum, c) => sum + c.n, 0);

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
          href="/admin/topics"
          className={`chip ${!filter ? "border-techelet text-techelet" : ""}`}
        >
          All ({total})
        </Link>
        {ORDER.map((s) => (
          <Link
            key={s}
            href={`/admin/topics?status=${s}`}
            className={`chip ${filter === s ? "border-techelet text-techelet" : ""}`}
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
              const doRetry = retryTopic.bind(null, t.id);
              const doSkip = skipTopic.bind(null, t.id);
              const doDelete = deleteTopic.bind(null, t.id);
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
                    <div className="flex items-center justify-end gap-3">
                      {status !== "pending" && status !== "running" && (
                        <form action={doRetry}>
                          <button type="submit" className="font-medium text-azure hover:text-techelet">
                            Re-queue
                          </button>
                        </form>
                      )}
                      {status === "pending" && (
                        <form action={doSkip}>
                          <button type="submit" className="font-medium text-muted hover:text-ink">
                            Skip
                          </button>
                        </form>
                      )}
                      <form action={doDelete}>
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
                  {filter
                    ? `No ${STATUS_LABELS[filter].toLowerCase()} topics.`
                    : "The queue is empty — add topics above, or import a list with `npm run topics:import`."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
