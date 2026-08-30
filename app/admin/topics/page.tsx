// app/admin/topics/page.tsx
import { requireAdmin } from "@/lib/auth-guard";
import { db } from "@/db";
import { articles, pipelineControl, topics, users } from "@/db/schema";
import { and, desc, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import {
  addTopics,
  deleteTopic,
  retryTopic,
  setPipelineEnabled,
  skipTopic,
} from "./actions";
import ScrollToHash from "./scroll-to-hash";

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

/**
 * Longest search term accepted. Anything past this is a paste accident, and a
 * pattern that long can only match nothing.
 */
const MAX_QUERY = 100;

/**
 * How long a heartbeat stays believable, in seconds.
 *
 * The worker stamps one every PIPELINE_CONTROL_POLL_MS (20s by default), so
 * three missed beats plus slack means something is genuinely wrong rather than
 * a slow round trip. Past this the panel stops claiming the pipeline is running
 * — a switch that reads "on" while nothing is listening is worse than no panel
 * at all.
 */
const HEARTBEAT_STALE_SECONDS = 90;

/**
 * Coarse relative time, from an age the DATABASE calculated.
 *
 * Deliberately not `Date.now() - row.someTimestamp`. These are `timestamp`
 * columns with no zone, and postgres-js reads them back shifted by whatever
 * timezone the reading process runs in — so comparing them against a JS clock
 * is correct only by the accident of the host running on UTC. Subtracting in
 * SQL is right everywhere.
 */
function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * A term as a case-insensitive "contains" pattern.
 *
 * `%`, `_` and `\` are LIKE wildcards, so they are escaped first — otherwise
 * searching for `100%` would silently match every topic, and a lone `_` would
 * match all of them. Backslash goes first: escaping it after the others would
 * escape the escapes.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The matched part of a topic, marked.
 *
 * Plain string slicing, not HTML — the term comes from the URL, and building
 * markup out of it would be an injection hole. React escapes all three pieces.
 * Only the first occurrence is marked; that is enough to see why a row matched.
 */
function Highlight({ text, term }: { text: string; term: string }) {
  const at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-brass/30 px-0.5 text-ink">
        {text.slice(at, at + term.length)}
      </mark>
      {text.slice(at + term.length)}
    </>
  );
}

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

/**
 * A link to one view/page, keeping the current search.
 *
 * Only the non-default view is written to the URL, and the default depends on
 * whether a search is running: a search spans every status (see below), so
 * `all` is the default then and `activity` is the one that must be named.
 *
 * The `#queue` fragment lands the reader on the list itself. Without it,
 * switching filter or turning a page from halfway down the table drops you back
 * at the page header and you have to scroll past it again every time.
 */
function hrefFor(view: View, page: number, q: string): string {
  const params = new URLSearchParams();
  if (view !== (q ? "all" : "activity")) params.set("status", view);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/topics${query ? `?${query}` : ""}#queue`;
}

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    q?: string;
    page?: string;
    added?: string;
    skipped?: string;
  }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const q = (params.q ?? "").trim().slice(0, MAX_QUERY);

  /**
   * A search defaults to EVERY status, not the usual activity digest.
   *
   * The question a search answers is "is this topic in the queue, and where has
   * it got to" — and the answer is `pending` for almost all of them, which the
   * activity view deliberately hides. Searching inside that view would report
   * "no matches" for a topic sitting in the queue. An explicit status in the URL
   * still wins, so the chips narrow a search as usual.
   */
  const chosen: View | null = ORDER.includes(params.status as Status)
    ? (params.status as Status)
    : params.status === "all"
      ? "all"
      : params.status === "activity"
        ? "activity"
        : null;
  const view: View = chosen ?? (q ? "all" : "activity");

  const requested = Number(params.page);
  const page = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;

  // Applied to the rows AND to the counts below, so the chips report how many
  // matches are in each bucket rather than how big the whole queue is.
  const search = q ? ilike(topics.topic, likePattern(q)) : undefined;

  const statusFilter =
    view === "all"
      ? undefined
      : view === "activity"
        ? inArray(topics.status, ACTIVITY)
        : eq(topics.status, view);

  const where = and(search, statusFilter);

  // The two queries are independent — one round trip to Neon instead of two.
  const [rows, counts, controlRows] = await Promise.all([
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
      .where(search)
      .groupBy(topics.status),
    // The pipeline switch, plus whatever the worker last reported about itself.
    db
      .select({
        enabled: pipelineControl.enabled,
        updatedAt: pipelineControl.updatedAt,
        updatedByName: users.name,
        workerState: pipelineControl.workerState,
        workerNote: pipelineControl.workerNote,
        workerTopic: pipelineControl.workerTopic,
        // Ages, not timestamps — see the note on ago().
        seenSecs: sql<
          number | null
        >`extract(epoch from (now() - ${pipelineControl.workerSeenAt}))::int`,
        switchedSecs: sql<
          number
        >`extract(epoch from (now() - ${pipelineControl.updatedAt}))::int`,
      })
      .from(pipelineControl)
      .leftJoin(users, eq(pipelineControl.updatedBy, users.id))
      .limit(1),
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

  const bucketLabel =
    view === "all"
      ? "topics"
      : view === "activity"
        ? "topics with activity"
        : `${STATUS_LABELS[view].toLowerCase()} topics`;
  const viewLabel = q ? `${bucketLabel} matching \u201c${q}\u201d` : bucketLabel;

  /**
   * What to say about the pipeline.
   *
   * Two separate facts: whether it is switched ON (what an admin asked for) and
   * whether a worker is actually ALIVE (what is true). The interesting states
   * are the ones where those disagree — switched on with nothing listening is
   * the failure this panel exists to make visible.
   */
  const control = controlRows[0] ?? null;
  const enabled = control?.enabled ?? false;
  const seenSecs = control?.seenSecs ?? null;
  const live = seenSecs !== null && seenSecs < HEARTBEAT_STALE_SECONDS;
  const workerState = control?.workerState ?? null;

  let tone: "good" | "warn" | "bad" | "idle";
  let headline: string;
  let detail: string;

  if (!control) {
    tone = "warn";
    headline = "Not set up";
    detail =
      "The pipeline_control row does not exist yet. Run `npm run db:migrate-pipeline`, " +
      "or press Start below to create it.";
  } else if (live && workerState === "misconfigured") {
    tone = "bad";
    headline = "Cannot run";
    detail = control.workerNote ?? "The worker reported a configuration problem.";
  } else if (enabled && live) {
    tone = "good";
    headline = "Running";
    detail =
      workerState === "working" && control.workerTopic
        ? `Writing \u201c${control.workerTopic}\u201d.`
        : (control.workerNote ?? "Waiting for a topic to claim.");
  } else if (enabled && !live) {
    tone = "warn";
    headline = "No worker";
    detail =
      seenSecs !== null
        ? `Switched on, but nothing has checked in since ${ago(seenSecs)}. The worker ` +
          `service is probably down or not deployed.`
        : "Switched on, but no worker has ever checked in. Is the worker service deployed?";
  } else if (live) {
    tone = "idle";
    headline = "Stopped";
    detail = "The worker is connected and waiting for you to start it.";
  } else {
    tone = "idle";
    headline = "Stopped";
    detail =
      seenSecs !== null
        ? `No worker connected — last seen ${ago(seenSecs)}.`
        : "No worker has checked in yet.";
  }

  const TONES = {
    good: "bg-emerald-500/15 text-emerald-700",
    warn: "bg-brass/25 text-brass",
    bad: "bg-[#b3261e]/15 text-[#b3261e]",
    idle: "bg-hairline-strong/30 text-muted",
  } as const;

  const added = Number(params.added);
  const skippedCount = Number(params.skipped);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      {/*
        Puts the reader on the anchor they asked for after a client-side
        navigation, which a server action's redirect() is. Harmless when the
        browser has already done it.
      */}
      <ScrollToHash trigger={`${view}|${q}|${page}|${params.added ?? ""}`} />
      <header className="mb-8">
        <span className="eyebrow">Editorial workspace</span>
        <h1 className="mt-1.5 font-display text-3xl font-bold text-ink">Topic queue</h1>
        <p className="mt-2 max-w-2xl text-[0.95rem] leading-relaxed text-muted">
          What the AI pipeline writes about. A run claims pending topics highest-priority
          first, researches, writes and fact-checks each one, then{" "}
          <strong className="font-semibold text-ink">publishes the article straight to the site</strong>.
          Anything the QA agent rejected or couldn&rsquo;t verify is held back as a draft and
          listed under <em>Needs human</em> below.
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-faint">
          This view lists the topics the pipeline has already worked on. The full waiting list
          is under <em>Pending</em>.
        </p>
      </header>

      {/*
        Pipeline control. The switch lives in the database because the worker
        runs on another host — see worker/src/lib/pipeline-control.ts. The state
        shown is a snapshot from when this page was rendered; reload to refresh.
      */}
      <section id="pipeline" className="card mb-8 scroll-mt-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold text-ink">AI pipeline</h2>
              <span className={`badge ${TONES[tone]}`}>{headline}</span>
            </div>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{detail}</p>
            <p className="mt-1 text-xs text-faint">
              {control
                ? `Switched ${enabled ? "on" : "off"} ${ago(control.switchedSecs)}` +
                  (control.updatedByName ? ` by ${control.updatedByName}` : "") +
                  (live && seenSecs !== null ? ` · worker seen ${ago(seenSecs)}` : "")
                : "No switch record yet."}
            </p>
          </div>

          <form action={setPipelineEnabled} className="shrink-0">
            <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
            <button type="submit" className={`btn ${enabled ? "btn-danger" : "btn-primary"}`}>
              {enabled ? "Stop the pipeline" : "Start the pipeline"}
            </button>
          </form>
        </div>

        <p className="mt-3 border-t border-hairline pt-3 text-xs leading-relaxed text-faint">
          Starting publishes articles to the live site and spends money on the research,
          writing and QA APIs. Stopping lets the topic already in progress finish first —
          it is never abandoned half-written. Either way the worker notices within about
          twenty seconds.
        </p>
      </section>

      {/* Add topics */}
      <form action={addTopics} className="card mb-8 p-5">
        <h2 className="font-display text-lg font-bold text-ink">Add topics</h2>
        <p className="mt-1 text-sm text-muted">
          One per line. Lines starting with <code>#</code> are ignored, and topics already in
          the queue are skipped. Anything added here goes to the{" "}
          <strong className="font-semibold text-ink">front of the queue</strong> — the pipeline
          picks it up before the existing backlog.
        </p>
        <textarea
          name="topics"
          rows={5}
          required
          placeholder={"Energy in Israel\nZvi Yehuda Kook\nMa'alot-Tarshiha"}
          className="input mt-3 font-mono text-sm"
        />
        <div className="mt-3 flex">
          <button type="submit" className="btn btn-primary ml-auto">
            Add to queue
          </button>
        </div>
      </form>

      {/* Search + status filter — the scroll target for every filter and pager
          link, so both stay visible with the table starting just below them. */}
      <div id="queue" className="mb-5 scroll-mt-6">
        {/*
          The confirmation lives HERE, not up beside the form that produced it.
          Adding topics redirects to #queue, so this is the first thing on
          screen afterwards — followed immediately by the new topics themselves,
          which now sort to the front of the pending list.
        */}
        {Number.isFinite(added) && params.added !== undefined && (
          <p className="mb-3 rounded-lg border border-brass/40 bg-brass/10 px-4 py-3 text-sm text-ink">
            {added > 0
              ? `Added ${added} topic${added === 1 ? "" : "s"} to the front of the queue.`
              : "No new topics were added."}
            {skippedCount > 0 && ` ${skippedCount} were already queued.`}
          </p>
        )}

        {/*
          A plain GET form: the search lives in the URL exactly like the status
          filter and the page number, so a result is shareable, survives a
          reload, and pages through without any client state.

          `page` is deliberately not carried over — a new search starts at the
          first page. Nor is `status`: a search should look everywhere first,
          and the chips below narrow it afterwards.

          The action carries `#queue` so submitting lands on the results rather
          than the top of the page. Only the query component of a form action is
          replaced on submit, so the fragment survives — and ScrollToHash below
          re-applies it regardless.
        */}
        <form
          method="get"
          action="/admin/topics#queue"
          className="flex flex-wrap items-center gap-2"
        >
          <input
            type="search"
            name="q"
            defaultValue={q}
            maxLength={MAX_QUERY}
            placeholder="Search topics…"
            aria-label="Search the topic queue"
            className="input h-10 w-full max-w-sm"
          />
          <button type="submit" className="btn btn-secondary">
            Search
          </button>
          {q && (
            <Link
              href="/admin/topics"
              className="text-sm font-medium text-muted hover:text-ink"
            >
              Clear
            </Link>
          )}
          {q && (
            <span className="text-sm text-faint">
              {total} match{total === 1 ? "" : "es"} across every status
            </span>
          )}
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href={hrefFor("activity", 1, q)}
            className={`chip ${view === "activity" ? "border-techelet text-techelet" : ""}`}
            title="Running, failed, needs human and done"
          >
            Activity ({activityTotal})
          </Link>
          <Link
            href={hrefFor("all", 1, q)}
            className={`chip ${view === "all" ? "border-techelet text-techelet" : ""}`}
          >
            All ({total})
          </Link>
          {ORDER.map((s) => (
            <Link
              key={s}
              href={hrefFor(s, 1, q)}
              className={`chip ${view === s ? "border-techelet text-techelet" : ""}`}
            >
              {STATUS_LABELS[s]} ({countFor(s)})
            </Link>
          ))}
        </div>
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
                      <span className="font-display text-base font-semibold text-ink">
                        <Highlight text={t.topic} term={q} />
                      </span>
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
                        href={hrefFor(view, 1, q)}
                        className="font-medium text-azure hover:text-techelet"
                      >
                        Back to the first page
                      </Link>
                    </>
                  ) : q ? (
                    <>
                      No {bucketLabel} match &ldquo;{q}&rdquo;.{" "}
                      {view === "all" ? (
                        <Link
                          href="/admin/topics"
                          className="font-medium text-azure hover:text-techelet"
                        >
                          Clear search
                        </Link>
                      ) : (
                        <Link
                          href={hrefFor("all", 1, q)}
                          className="font-medium text-azure hover:text-techelet"
                        >
                          Search every status
                        </Link>
                      )}
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
                  href={hrefFor(view, page - 1, q)}
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
                  href={hrefFor(view, page + 1, q)}
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
