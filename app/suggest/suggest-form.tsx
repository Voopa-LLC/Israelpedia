"use client";

import { useActionState } from "react";
import { suggestArticle } from "./actions";

export default function SuggestForm() {
  const [state, action, pending] = useActionState(suggestArticle, null);

  if (state?.success) {
    return (
      <div className="sg-done">
        <span className="sg-done-mark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <h2 className="sg-done-title">Suggestion received</h2>
        <p className="sg-done-body">
          Thanks — your topic is in our review queue. If we cover it, you’ll be
          able to read it right here.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      {state && !state.success && (
        <p className="sg-error">{state.error}</p>
      )}

      <div>
        <label htmlFor="topic" className="sg-label">
          Topic <span className="sg-required">*</span>
        </label>
        <input
          id="topic"
          name="topic"
          type="text"
          required
          dir="auto"
          placeholder="e.g. Golda Meir, Hanukkah, the Dead Sea Scrolls"
          className="sg-input"
        />
      </div>

      <div>
        <label htmlFor="rationale" className="sg-label">
          Why should we cover this? <span className="sg-hint">(optional)</span>
        </label>
        <textarea
          id="rationale"
          name="rationale"
          rows={4}
          placeholder="A sentence or two on why this topic matters and what it should include."
          className="sg-textarea"
        />
      </div>

      <div>
        <button type="submit" disabled={pending} className="hp-btn sg-submit">
          {pending ? "Submitting…" : "Submit suggestion"}
        </button>
      </div>
    </form>
  );
}
