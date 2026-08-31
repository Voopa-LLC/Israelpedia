"use client";

import { useActionState } from "react";
import { suggestArticle } from "./actions";

export default function SuggestForm() {
  const [state, action, pending] = useActionState(suggestArticle, null);

  if (state?.success) {
    return (
      <div className="flex flex-col items-start gap-3 py-4 text-center sm:items-center sm:text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-techelet/10 text-techelet">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <h2 className="font-display text-2xl font-bold text-ink">Suggestion received</h2>
        <p className="max-w-sm text-muted">
          Thanks — your topic is in our review queue. If we cover it, you’ll be
          able to read it right here.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      {state && !state.success && (
        <p className="rounded-md border border-[#b3261e]/30 bg-[#b3261e]/8 px-4 py-3 text-sm font-medium text-[#b3261e]">
          {state.error}
        </p>
      )}

      <div>
        <label htmlFor="topic" className="field-label">
          Topic <span className="text-brass">*</span>
        </label>
        <input
          id="topic"
          name="topic"
          type="text"
          required
          dir="auto"
          placeholder="e.g. Golda Meir, Hanukkah, the Dead Sea Scrolls"
          className="input"
        />
      </div>

      <div>
        <label htmlFor="rationale" className="field-label">
          Why should we cover this?{" "}
          <span className="field-hint">(optional)</span>
        </label>
        <textarea
          id="rationale"
          name="rationale"
          rows={4}
          placeholder="A sentence or two on why this topic matters and what it should include."
          className="textarea"
        />
      </div>

      <div>
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Submitting…" : "Submit suggestion"}
        </button>
      </div>
    </form>
  );
}
