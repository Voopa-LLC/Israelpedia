// app/admin/new/article-form.tsx
"use client";

import { useState } from "react";
import { createArticle } from "../actions";
import { ARTICLE_CATEGORIES, categoryLabel } from "@/lib/article-categories";

export default function ArticleForm() {
  const [refs, setRefs] = useState([{ url: "", title: "", source: "" }]);
  const [showHebrew, setShowHebrew] = useState(false);

  const addRef = () => setRefs([...refs, { url: "", title: "", source: "" }]);
  const removeRef = (i: number) => setRefs(refs.filter((_, idx) => idx !== i));

  return (
    <form action={createArticle} className="flex flex-col gap-8">

      {/* ── English ───────────────────────────────────────────────── */}
      <section className="flex flex-col gap-5">
        <div className="flex items-center gap-3 border-b border-hairline pb-3">
          <h2 className="font-display text-lg font-bold text-ink">English</h2>
        </div>

        <div>
          <label htmlFor="title" className="field-label">Title</label>
          <input id="title" name="title" required className="input" />
        </div>

        <div>
          <label htmlFor="summary" className="field-label">
            Summary <span className="field-hint">(the lede shown under the title)</span>
          </label>
          <textarea id="summary" name="summary" rows={2} className="textarea" />
        </div>

        <div>
          <label htmlFor="body" className="field-label">
            Body <span className="field-hint">(Markdown — headings, lists, links, tables)</span>
          </label>
          <textarea id="body" name="body" rows={16} required className="textarea font-mono text-sm" />
        </div>
      </section>

      {/* ── Hebrew (optional) ─────────────────────────────────────── */}
      <section>
        <div className="flex items-center gap-3 border-b border-hairline pb-3">
          <h2 className="font-display text-lg font-bold text-ink">עברית</h2>
          <span className="text-sm text-muted">Hebrew — optional</span>
          <button
            type="button"
            onClick={() => setShowHebrew((v) => !v)}
            className="ml-auto text-sm font-medium text-azure hover:text-techelet"
          >
            {showHebrew ? "Hide" : "Add Hebrew"}
          </button>
        </div>

        {showHebrew && (
          <div className="mt-5 flex flex-col gap-5">
            <div>
              <label htmlFor="titleHe" className="field-label">כותרת (Title)</label>
              <input
                id="titleHe"
                name="titleHe"
                dir="rtl"
                lang="he"
                className="input"
                placeholder="כותרת המאמר בעברית"
              />
            </div>

            <div>
              <label htmlFor="summaryHe" className="field-label">תקציר (Summary)</label>
              <textarea
                id="summaryHe"
                name="summaryHe"
                rows={2}
                dir="rtl"
                lang="he"
                className="textarea"
                placeholder="תקציר קצר של המאמר"
              />
            </div>

            <div>
              <label htmlFor="bodyHe" className="field-label">
                גוף המאמר (Body) <span className="field-hint">(Markdown)</span>
              </label>
              <textarea
                id="bodyHe"
                name="bodyHe"
                rows={16}
                dir="rtl"
                lang="he"
                className="textarea text-sm"
                placeholder="תוכן המאמר בפורמט Markdown…"
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Metadata ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-5 sm:flex-row sm:gap-6">
        <div className="sm:w-56">
          <label htmlFor="status" className="field-label">Status</label>
          <select id="status" name="status" className="select">
            <option value="draft">Draft</option>
            <option value="review">Review</option>
            <option value="published">Published</option>
          </select>
        </div>

        <div className="sm:w-56">
          <label htmlFor="category" className="field-label">
            Category <span className="field-hint">(the chip on article cards)</span>
          </label>
          {/* The same four the Research Agent uses, so a hand-written article
              and a generated one are labelled identically. */}
          <select id="category" name="category" defaultValue="" className="select">
            <option value="">— None —</option>
            {ARTICLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── References ───────────────────────────────────────────── */}
      <fieldset className="card p-5">
        <legend className="px-2 font-display text-lg font-bold text-ink">References</legend>
        <p className="mb-4 text-sm text-muted">
          Add the sources that back this article. Each needs at least a title or URL.
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
        <button type="submit" className="btn btn-primary">Create article</button>
      </div>
    </form>
  );
}
