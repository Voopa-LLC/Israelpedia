// app/admin/qa/[slug]/page.tsx
//
// The QA Agent's full report for one article: verdict, confidence, the summary
// it wrote, every change it applied to the draft, and every issue it could not
// resolve. Reached from the "QA report" action in the admin article list.
//
// Reports are stored per RUN (see `article_qa_reports` in db/schema.ts), so an
// article that has been through the pipeline more than once has more than one.
// The newest is shown by default; ?run=<id> opens an earlier one.
//
// Nothing was backfilled: articles produced before the table existed have no
// report, and land on the empty state below.
import { requireAdmin } from "@/lib/auth-guard";
import { db } from "@/db";
import {
  articleQaReports,
  articles,
  type QaReportChange,
  type QaReportIssue,
} from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";

export const metadata = { title: "QA report" };

const VERDICT_LABELS: Record<string, string> = {
  pass: "Pass",
  pass_with_edits: "Pass with edits",
  flag: "Flag",
  reject: "Reject",
};

// The same palette the topic queue uses for its status chips, so a verdict
// reads as the same colour in both places.
const VERDICT_STYLES: Record<string, string> = {
  pass: "bg-emerald-500/15 text-emerald-700",
  pass_with_edits: "bg-azure/15 text-azure",
  flag: "bg-brass/20 text-brass",
  reject: "bg-[#b3261e]/15 text-[#b3261e]",
};

const VERDICT_NOTES: Record<string, string> = {
  pass: "QA found nothing to correct.",
  pass_with_edits:
    "QA corrected the draft itself; the corrected text is what was published.",
  flag:
    "QA published the article but left problems it could not resolve — read the issues below.",
  reject:
    "QA would not stand behind this article. It was saved as a draft and never published.",
};

const SEVERITY_STYLES: Record<string, string> = {
  high: "bg-[#b3261e]/15 text-[#b3261e]",
  medium: "bg-brass/20 text-brass",
  low: "bg-hairline-strong/30 text-muted",
};

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const CHANGE_TYPE_LABELS: Record<string, string> = {
  citation_fix: "Citation fix",
  char_limit_trim: "Length trim",
  terminology_correction: "Terminology",
  claim_removed: "Claim removed",
  content_rewrite: "Rewrite",
  section_drafted: "Section drafted",
  structural_fix: "Structural fix",
  other: "Other",
};

const ISSUE_TYPE_LABELS: Record<string, string> = {
  citation_untraceable: "Citation untraceable",
  source_mismatch: "Source mismatch",
  source_unverifiable: "Source unverifiable",
  internal_contradiction: "Internal contradiction",
  overclaiming: "Overclaiming",
  structural_missing_section: "Missing section",
  style_drift: "Style drift",
  char_limit_exceeded: "Over length",
  generic_template: "Generic / template text",
  other: "Other",
};

const SAVED_STATUS_LABELS: Record<string, string> = {
  published: "Published",
  review: "Held for review",
  draft: "Saved as draft",
};

const RESEARCH_VARIANT_LABELS: Record<string, string> = {
  perplexity: "Perplexity",
  claude: "Claude",
  gpt: "GPT",
};

/** Fall back to the raw value, readably, if the agents add a new one. */
function label(map: Record<string, string>, key: string | null): string {
  if (!key) return "—";
  return map[key] ?? key.replace(/_/g, " ");
}

function formatDateTime(d: Date): string {
  return new Date(d).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The way out of this page: a real button, next to the breadcrumb and again at the end. */
function CloseButton({ className = "" }: { className?: string }) {
  return (
    <Link href="/admin" className={`btn btn-secondary ${className}`}>
      Close
    </Link>
  );
}

function MetaItem({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">{term}</dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function QaReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  await requireAdmin();
  const { slug } = await params;
  const { run } = await searchParams;

  const [article] = await db.select().from(articles).where(eq(articles.slug, slug));
  if (!article) notFound();

  const runs = await db
    .select()
    .from(articleQaReports)
    .where(eq(articleQaReports.articleId, article.id))
    .orderBy(desc(articleQaReports.createdAt));

  // ?run=<id> opens an earlier run; anything unrecognised falls back to the
  // newest rather than 404-ing, so a stale link still shows something useful.
  const report = (run ? runs.find((r) => r.id === run) : undefined) ?? runs[0];

  const header = (
    <>
      <nav className="mb-6 flex items-center justify-between gap-4" aria-label="Breadcrumb">
        <Link href="/admin" className="text-sm text-muted transition-colors hover:text-techelet">
          ← Back to articles
        </Link>
        <CloseButton />
      </nav>
      <header className="mb-8">
        <span className="eyebrow">QA report</span>
        <h1 className="mt-1.5 font-display text-3xl font-bold text-ink">{article.title}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <Link href={`/article/${article.slug}`} className="link">
            View article
          </Link>
          <span className="text-faint" aria-hidden="true">
            ·
          </span>
          <Link href={`/admin/edit/${article.slug}`} className="link">
            Edit article
          </Link>
        </p>
      </header>
    </>
  );

  if (!report) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        {header}
        <div className="rounded-lg border border-dashed border-hairline-strong bg-card/50 px-6 py-12 text-center">
          <p className="text-muted">No QA report is stored for this article.</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-faint">
            Reports are saved by the AI pipeline from the run that produces the article.
            Articles written by hand, and those the pipeline produced before reports were
            stored in the database, do not have one.
          </p>
          <CloseButton className="mt-6" />
        </div>
      </main>
    );
  }

  const changes: QaReportChange[] = Array.isArray(report.changes) ? report.changes : [];
  const issues: QaReportIssue[] = Array.isArray(report.issues) ? report.issues : [];
  // Worst first — the point of this list is what still needs a human.
  const sortedIssues = [...issues].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );

  const confidencePct = report.confidence === null ? null : Math.round(report.confidence * 100);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      {header}

      {/* Verdict, score, and what the run did */}
      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <span
              className={`badge ${
                VERDICT_STYLES[report.verdict] ?? "bg-hairline-strong/30 text-muted"
              }`}
            >
              {label(VERDICT_LABELS, report.verdict)}
            </span>
            <p className="mt-2 max-w-md text-sm text-muted">
              {VERDICT_NOTES[report.verdict] ?? "Verdict recorded by the QA Agent."}
            </p>
            {report.verdict === "reject" && report.rejectTarget && (
              <p className="mt-1 text-sm text-muted">
                Sent back to the{" "}
                <span className="font-semibold text-ink">
                  {report.rejectTarget.replace(/_/g, " ")}
                </span>
                .
              </p>
            )}
          </div>

          {/* Score */}
          <div className="min-w-[11rem]">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">
              Confidence
            </div>
            {confidencePct === null ? (
              <div className="mt-1 font-display text-3xl font-bold text-faint">—</div>
            ) : (
              <>
                <div className="mt-1 font-display text-3xl font-bold text-ink">
                  {confidencePct}
                  <span className="text-lg font-semibold text-muted">%</span>
                </div>
                <div
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-hairline"
                  role="img"
                  aria-label={`Confidence ${confidencePct} percent`}
                >
                  <div
                    className="h-full rounded-full bg-techelet"
                    style={{ width: `${confidencePct}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {report.summary && (
          <p className="mt-6 border-t border-hairline pt-5 text-[0.95rem] leading-relaxed text-ink">
            {report.summary}
          </p>
        )}

        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-hairline pt-5 sm:grid-cols-4">
          <MetaItem term="Changes">{changes.length}</MetaItem>
          <MetaItem term="Unresolved issues">{issues.length}</MetaItem>
          <MetaItem term="Outcome">{label(SAVED_STATUS_LABELS, report.savedStatus)}</MetaItem>
          <MetaItem term="Research">
            {label(RESEARCH_VARIANT_LABELS, report.researchVariant)}
          </MetaItem>
          <MetaItem term="Run recorded">{formatDateTime(report.createdAt)}</MetaItem>
        </dl>
      </section>

      {/* Unresolved issues — the part that still needs a human */}
      <section className="mt-10">
        <div className="mb-5 flex items-center gap-3 border-b border-hairline pb-3">
          <h2 className="font-display text-2xl font-bold text-ink">Unresolved issues</h2>
          <span
            className={`badge ${
              issues.length > 0 ? "bg-brass/15 text-brass" : "bg-hairline-strong/30 text-muted"
            }`}
          >
            {issues.length}
          </span>
        </div>

        {sortedIssues.length === 0 ? (
          <p className="rounded-lg border border-dashed border-hairline-strong bg-card/50 px-4 py-8 text-center text-muted">
            QA left no unresolved issues on this article.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {sortedIssues.map((issue, i) => (
              <li key={i} className="card p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`badge ${
                      SEVERITY_STYLES[issue.severity] ?? "bg-hairline-strong/30 text-muted"
                    }`}
                  >
                    {issue.severity ? issue.severity.toUpperCase() : "UNRATED"}
                  </span>
                  <span className="text-sm font-semibold text-ink">
                    {label(ISSUE_TYPE_LABELS, issue.type)}
                  </span>
                  {issue.section && (
                    <>
                      <span className="text-faint" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-sm text-muted">{issue.section}</span>
                    </>
                  )}
                </div>
                <p className="mt-2.5 text-[0.95rem] leading-relaxed text-ink">
                  {issue.description}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Everything QA fixed itself */}
      <section className="mt-12">
        <div className="mb-5 flex items-center gap-3 border-b border-hairline pb-3">
          <h2 className="font-display text-2xl font-bold text-ink">Changes QA applied</h2>
          <span
            className={`badge ${
              changes.length > 0 ? "bg-azure/15 text-azure" : "bg-hairline-strong/30 text-muted"
            }`}
          >
            {changes.length}
          </span>
        </div>

        {changes.length === 0 ? (
          <p className="rounded-lg border border-dashed border-hairline-strong bg-card/50 px-4 py-8 text-center text-muted">
            QA changed nothing — the article stands as the Writing Agent wrote it.
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {changes.map((change, i) => (
              <li key={i} className="card p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge bg-hairline-strong/30 text-muted">{i + 1}</span>
                  <span className="text-sm font-semibold text-ink">
                    {label(CHANGE_TYPE_LABELS, change.change_type)}
                  </span>
                  {change.section && (
                    <>
                      <span className="text-faint" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-sm text-muted">{change.section}</span>
                    </>
                  )}
                </div>

                {change.reason && (
                  <p className="mt-2.5 text-[0.95rem] leading-relaxed text-ink">{change.reason}</p>
                )}

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border-l-2 border-[#b3261e]/50 bg-paper/60 px-3.5 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">
                      Before
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">
                      {change.before || "— nothing; this text was added"}
                    </p>
                  </div>
                  <div className="rounded-md border-l-2 border-emerald-600/50 bg-paper/60 px-3.5 py-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">
                      After
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                      {change.after || "— nothing; this text was removed"}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Earlier runs — only when this article has been through the pipeline twice */}
      {runs.length > 1 && (
        <section className="mt-12">
          <div className="mb-5 flex items-center gap-3 border-b border-hairline pb-3">
            <h2 className="font-display text-2xl font-bold text-ink">All QA runs</h2>
            <span className="badge bg-hairline-strong/30 text-muted">{runs.length}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {runs.map((r, i) => {
              const current = r.id === report.id;
              return (
                <li key={r.id}>
                  <Link
                    href={`/admin/qa/${article.slug}${i === 0 ? "" : `?run=${r.id}`}`}
                    aria-current={current ? "true" : undefined}
                    className={`flex flex-wrap items-center gap-3 rounded-md px-3.5 py-2.5 text-sm transition-colors ${
                      current ? "bg-paper" : "hover:bg-paper/60"
                    }`}
                  >
                    <span
                      className={`badge ${
                        VERDICT_STYLES[r.verdict] ?? "bg-hairline-strong/30 text-muted"
                      }`}
                    >
                      {label(VERDICT_LABELS, r.verdict)}
                    </span>
                    <span className="text-muted">{formatDateTime(r.createdAt)}</span>
                    <span className="text-faint">
                      {r.changeCount} change{r.changeCount === 1 ? "" : "s"} · {r.issueCount} issue
                      {r.issueCount === 1 ? "" : "s"}
                    </span>
                    {current && (
                      <span className="ml-auto text-xs font-semibold text-techelet">Showing</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="mt-12 flex justify-end border-t border-hairline pt-6">
        <CloseButton />
      </div>
    </main>
  );
}
