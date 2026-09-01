"use client";

import { useState } from "react";
import { updateArticle } from "../../actions";
import { ARTICLE_CATEGORIES, categoryLabel } from "@/lib/article-categories";

type Ref = { url: string; title: string; source: string };

type Props = {
  article: {
    id: string;
    slug: string;
    title: string;
    summary: string;
    body: string;
    titleHe: string;
    summaryHe: string;
    bodyHe: string;
    status: string;
    /** "" when the article has none — an AI article carries what Research picked. */
    category: string;
  };
  initialRefs: Ref[];
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline pb-3">
      <h2 className="font-display text-lg font-bold text-ink">{children}</h2>
    </div>
  );
}

export default function ArticleEditForm({ article, initialRefs }: Props) {
  const [refs, setRefs] = useState<Ref[]>(
    initialRefs.length > 0 ? initialRefs : [{ url: "", title: "", source: "" }]
  );

  const addRef = () => setRefs([...refs, { url: "", title: "", source: "" }]);
  const removeRef = (i: number) => setRefs(refs.filter((_, idx) => idx !== i));

  return (
    <form action={updateArticle} className="flex flex-col gap-8">
      <input type="hidden" name="articleId" value={article.id} />
      <input type="hidden" name="articleSlug" value={article.slug} />

      {/* ── English ───────────────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <SectionHeading>English</SectionHeading>

        <div>
          <label htmlFor="title" className="field-label">Title</label>
          <input id="title" name="title" required defaultValue={article.title} className="input" />
        </div>

        <div>
          <label htmlFor="summary" className="field-label">
            Summary <span className="field-hint">(the lede shown under the title)</span>
          </label>
          <textarea id="summary" name="summary" rows={2} defaultValue={article.summary} className="textarea" />
        </div>

        <div>
          <label htmlFor="body" className="field-label">
            Body <span className="field-hint">(Markdown — headings, lists, links, tables)</span>
          </label>
          <textarea
            id="body"
            name="body"
            rows={16}
            required
            defaultValue={article.body}
            className="textarea font-mono text-sm"
          />
        </div>
      </section>

      {/* ── Hebrew (עברית) ────────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <SectionHeading>
          עברית{" "}
          <span className="text-sm font-normal text-muted">(Hebrew — optional, edited right-to-left)</span>
        </SectionHeading>

        <div>
          <label htmlFor="titleHe" className="field-label">כותרת (Title)</label>
          <input
            id="titleHe"
            name="titleHe"
            dir="rtl"
            lang="he"
            defaultValue={article.titleHe}
            className="input"
            placeholder="כותרת המאמר בעברית"
          />
        </div>

        <div>
          <label htmlFor="summaryHe" className="field-label">
            תקציר (Summary)
          </label>
          <textarea
            id="summaryHe"
            name="summaryHe"
            rows={2}
            dir="rtl"
            lang="he"
            defaultValue={article.summaryHe}
            className="textarea"
            placeholder="תקציר קצר של המאמר"
          />
        </div>

        <div>
          <label htmlFor="bodyHe" className="field-label">
            גוף המאמר (Body){" "}
            <span className="field-hint">(Markdown)</span>
          </label>
          <textarea
            id="bodyHe"
            name="bodyHe"
            rows={16}
            dir="rtl"
            lang="he"
            defaultValue={article.bodyHe}
            className="textarea text-sm"
            placeholder="תוכן המאמר בפורמט Markdown…"
          />
        </div>
      </section>

      {/* ── Metadata ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <SectionHeading>Metadata</SectionHeading>

        <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
          <div className="sm:w-56">
            <label htmlFor="status" className="field-label">Status</label>
            <select id="status" name="status" defaultValue={article.status} className="select">
              <option value="draft">Draft</option>
              <option value="review">Review</option>
              <option value="published">Published</option>
            </select>
          </div>

          <div className="sm:w-56">
            <label htmlFor="category" className="field-label">
              Category <span className="field-hint">(the chip on article cards)</span>
            </label>
            {/* On an AI article this shows what the Research Agent resolved, and
                changing it here overrides that. A re-run of the same topic
                rewrites it, since the pipeline owns the value it produces. */}
            <select
              id="category"
              name="category"
              defaultValue={article.category}
              className="select"
            >
              <option value="">— None —</option>
              {ARTICLE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{categoryLabel(c)}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="editorNote" className="field-label">
            Editor note <span className="field-hint">(optional — describes what changed)</span>
          </label>
          <textarea id="editorNote" name="editorNote" rows={2} className="textarea" />
        </div>
      </section>

      {/* ── References ───────────────────────────────────────────── */}
      <fieldset className="card p-5">
        <legend className="px-2 font-display text-lg font-bold text-ink">References</legend>
        <p className="mb-4 text-sm text-muted">
          Saving replaces all references with the list below. Each needs at least a title or URL.
        </p>
        <div className="flex flex-col gap-4">
          {refs.map((ref, i) => (
            <div key={i} className="rounded-lg border border-hairline bg-paper/50 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Source {i + 1}</span>
                {refs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRef(i)}
                    className="text-sm font-medium text-[#b3261e] hover:opacity-75"
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <input name="ref_title" placeholder="Reference title" defaultValue={ref.title} className="input" />
                <input name="ref_url" placeholder="https://…" defaultValue={ref.url} className="input" />
                <input name="ref_source" placeholder="Source / publisher" defaultValue={ref.source} className="input" />
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={addRef} className="btn btn-secondary mt-4">
          + Add reference
        </button>
      </fieldset>

      <div>
        <button type="submit" className="btn btn-primary">Save changes</button>
      </div>
    </form>
  );
}
