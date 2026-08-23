# IsraelPedia — Agent Revision Recommendations
*Based on review of the three July 19 trial runs (Israel, Moses, Six-Day War) against the current Research/Writing/QA Agent specs.*

## Root cause chain

The five review comments trace back to one underlying issue: **the Research Agent's output is too thin, and that thinness propagates through the whole pipeline.**

- The Research Agent spec currently defines a fact as *"a single, atomic factual claim"* — literally one short sentence per bundle entry, stripped of surrounding context, argument, and detail.
- Because that's all the Writing Agent has to draw on, articles end up as a string of short, disconnected sentences, each hung off a footnote, rather than flowing paragraphs — which is also why "according to [Source]" gets repeated so often: naming the source is doing the work that context and connective prose should be doing.
- Because the bundle is thin relative to how much the sources actually contain, the QA Agent's "unused bundle material" safety valve — which is supposed to let it enrich a thin article — has little to work with beyond what the Writing Agent already used, so it rarely gets exercised.
- Short articles with thin sourcing then over-index on whatever *is* flagged as contested, because the controversy flags are one of the few thick data points at hand — hence the disproportionate weight on Moses's "Controversies and scholarly debate" section.

Fixing the Research Agent's extraction depth is the highest-leverage change here. The other changes below are still needed independently, but several of them (word count, "according to X" overuse, thin overview sections) will partially self-correct once the bundle is richer.

---

## 0. Additional finding: rewritten sections are landing at the end of the article, out of order

This is a distinct issue from the "unused bundle material" point in section 3.1 below, and it's arguably the single most damaging defect in the two longer trial runs.

**Evidence — Israel:** the "Overview and location" section appears near the top of the document, captioned "Section removed by QA — see the change log below," followed by the Writing Agent's original text. QA's change log (item 3, `content_rewrite — Overview`) shows a before/after swap of that same content. But a *second*, fully-rewritten "Overview" section reappears much later in the document — after "Demographics" — captioned **"Section drafted by QA from unused bundle material."** Its text is a near-exact match for the change log's "+" (replacement) text. This is the same section, not a new one, but it's shown twice and the corrected version is relocated to the end of the article.

**Evidence — Six-Day War:** identical pattern. "Background and causes" appears near the top, captioned "Section removed by QA," holding the original draft. QA's change log (item 4, `content_rewrite — Background`) rewrites one sentence of it. But a full "Background" section reappears **after the "Controversies" section, near the very end of the article**, again captioned "Section drafted by QA from unused bundle material" — and its text matches the change log's replacement almost verbatim. This is why the article reads as if it jumps straight from the lead into "Course of events" with no context: the Background section's corrected content exists, but it's been relocated to the bottom of the document instead of staying in its template position right after the lead.

**Two possible causes — the developer should check both:**
1. **A reporting/rendering artifact.** Whoever assembled this particular trial-run PDF may have grouped "the original draft with small inline diffs" separately from "the full text of anything QA substantially changed or added," and captioned that whole second group uniformly as "drafted from unused bundle material" — regardless of whether the underlying `change_type` was actually `content_rewrite` (an edit to an existing section) or `section_drafted` (a genuinely new section). If so, the real `edited_article.sections` array coming out of the QA Agent may already be correctly ordered, and the fix belongs in whatever tool generated this review document, not in the agent specs.
2. **A real bug in how QA assembles `edited_article`.** When QA performs a substantial `content_rewrite` on an existing section, it may be appending the corrected version as a *new* entry at the end of the `sections[]` array instead of overwriting the existing entry in place — leaving a stale "before" version sitting in its correct template position and an orphaned "after" version at the bottom.

**Recommended change (covers either cause):**
- Add an explicit rule to the QA Agent spec (Content Rule 1, or a new rule near it) stating that **`edited_article.sections` must preserve the category template's section order** (per `IsraelPedia Writing Agent Spec.md` Content Rule 2), and that any `content_rewrite` or `section_drafted` change must be applied **to the section's existing position in that array** — never appended as a trailing extra entry. A section that already exists and is being rewritten must be edited in place, not duplicated.
- Before treating a spec change as the full fix, the developer should inspect the raw `edited_article` JSON from a trial run (not just this human-readable PDF) to determine whether cause 1 or cause 2 is actually happening. If it's cause 1, the PDF-generation tooling needs the fix instead of (or in addition to) the agent spec.

---

## 1. Research Agent

**File:** `IsraelPedia Research Agent Spec.md`

### 1.1 Replace atomic one-line facts with substantive per-source notes
**Current behavior:** `facts[].text` is defined as *"a single, atomic factual claim"* (Output schema, and Rule 4 in the production prompt: *"Never state a fact you cannot attribute..."* — implemented as one short sentence per entry). The trial runs show this literally: e.g. Israel fact #6 is one clause about borders, fact #7 is one clause about area — each pulled from a source (like *Israel in Brief* or the CIA factbook page) that plainly contains a full paragraph of context the agent didn't capture.

**Recommended change:**
- Redefine what counts as a usable unit of research output. Instead of forcing every extraction into a single atomic sentence, allow the agent to produce **short paragraphs (2–5 sentences) per source** that preserve context: the specific claim, the surrounding detail/nuance, relevant dates, named actors, and (where present) a supporting quotation or figure.
- Keep the atomic-fact discipline for QA's fact-checking purposes (each discrete claim still needs to be independently traceable and verifiable), but stop forcing the Writing Agent to reconstruct context from a pile of disconnected one-liners. Practically, this likely means changing `facts[].text` from "a single atomic claim" to "a substantive note — one or more related sentences drawn from a single source passage," while still keeping one `source_url` per entry so traceability doesn't degrade.
- Add an explicit instruction: **the depth of extraction should scale with the richness of the source.** A single-paragraph news brief should yield one or two notes; a multi-page government backgrounder, historical archive page, or academic article should yield many more, including secondary details, dates, named figures, and direct quotations, not just the single headline claim. Currently every source in the trial runs — regardless of depth — seems to produce roughly one fact.
- Mine each source more completely before moving on: dates, numbers, direct quotes, named actors, cause/effect, and any context the source gives for *why* something happened, not just *that* it happened. This is the material the Writing Agent needs to write connected prose instead of a list of footnoted clauses.

### 1.2 Cost/technical implication to flag to the developer
Deeper per-source extraction may increase output size and could push more topics toward `sonar-pro` rather than the default `sonar` tier (per the existing "Model / Provider" section), since more thorough extraction benefits from a stronger model. This is a cost tradeoff the developer should decide on explicitly rather than have it happen implicitly — worth a line in the spec's Model/Provider section noting that extraction depth may be a second signal (alongside topic complexity) for escalating tiers.

### 1.3 No change needed to sourcing/allowlist rules
The hard source restriction, controversy-flagging, and distinctive-material extraction rules are working as designed and shouldn't change — the problem is depth of extraction per approved source, not which sources are used.

---

## 2. Writing Agent

**File:** `IsraelPedia Writing Agent Spec.md`

### 2.1 Add an explicit target word count for the whole article
**Current behavior:** the spec has granular character limits for the lead, headings, and per-paragraph splitting (Content Rule 5), but **no target or floor for total article length.** This is exactly why the Israel article came out short despite a 45-fact bundle — nothing in the spec tells the agent how much total material to produce, only how to format what it does write.

**Recommended change:**
- Add a new line to Content Rule 5's limits table (or a new Rule 5a): **target total article length of roughly 1,000–3,000 words**, scaled to how much usable material the bundle actually contains — richer bundles (more facts, more distinctive material, more sources) should land toward the top of that range; thin bundles should land lower, but the agent should not artificially pad a thin topic just to hit a floor (this should stay consistent with the existing thin-bundle edge case in the spec, which already says not to pad with filler).
- Make this visible in the output: consider adding a `word_count` (or `estimated_word_count`) field to the article JSON so it's checkable downstream by QA and by the developer's pipeline metrics, rather than being an invisible/unverified instruction.

### 2.2 Lengthen the lead itself, and stop treating "Overview" and "Background" as interchangeable
**Terminology check first, since this is easy to conflate:** in the Writing Agent spec, "the lead" refers specifically to the `summary` JSON field — the short Wikipedia-style blurb that sits *before* the first section heading (250–900 chars, up to 1,500 across 2 paragraphs). That's distinct from the section-level content addressed below. The original feedback asked for two separate improvements:
1. *"Increase the permitted character or word count for the introduction"* — the `summary`/lead limit itself should go up.
2. *"An Overview or Background section should appear near the beginning... a clear summary of the subject, its significance, and the main themes."*

**On #2 — Overview and Background are not the same thing, and shouldn't be treated as one interchangeable label.** The current category templates (Content Rule 2) already keep them category-specific, not synonymous — Place and Concept get "Overview," Event gets "Background," Person gets neither — so the spec's instinct is right, but the *content* each is supposed to carry isn't clearly defined, and that's the actual gap:
- **Overview** should be what your feedback describes: a broad, non-chronological summary of what the subject *is*, why it *matters*, and what themes the rest of the article will cover — the "clear summary of significance and main themes" the reader needs before the detailed sections. The Israel trial run's "Overview" section is a good example of the current gap: it's just geographic facts (coordinates, border length, terrain) copied from the bundle — it never actually states why Israel is significant or previews the article's themes. That's a content-definition failure, not a length or placement one.
- **Background** should specifically be lead-up context and causes — the situation *before* the main narrative starts. This fits Event cleanly (pre-war tensions, etc.) and is a poor fit for Person (a person doesn't have "background" the way an event does) — but it could be relevant to Place or Concept when there's real antecedent context to establish (e.g., a place with a name change, a concept with a clear point of origin).
- **Where a category could plausibly want both** (e.g., a Place article with both "what this place is and why it matters" *and* "how it came to be this way"), that should be a deliberate, per-category decision by your team, not something solved by a single generic "Overview/Background" section — flagging this for a decision rather than prescribing it here, since it's a content-modeling call, not a formatting one.

**Current behavior:** per the finding in section 0 above, in the Israel trial run the corrected "Overview" content ends up relocated to the end of the document instead of surfacing where a reader would expect it, and the lead itself is capped fairly tightly at 900–1,500 characters, which reads as thin for an opening on a topic like Israel or the Six-Day War.

**Recommended change:**
- **Increase the lead's own length limit.** Raise the single-paragraph cap from 900 to something like 1,200 characters, and the two-paragraph extended cap from 1,500 to roughly 2,000–2,200 characters, for bundles rich enough to support it (thin bundles should still be allowed to stay short — this is a ceiling increase, not a new floor). This directly answers "increase the permitted character or word count for the introduction."
- **Give the Writing Agent's category templates an explicit content definition for "Overview" (significance + main themes, not a raw fact dump) and for "Background" (lead-up context/causes), rather than leaving each section's purpose implicit in its name.** Right now the spec tells the agent *when* to use each heading but not *what kind of content belongs in it* — which is why Israel's "Overview" ended up being interchangeable with a geography subsection instead of doing the significance/themes job your feedback asked for.
- Fix the placement bug in section 0 so whichever section(s) apply actually appear in their template position (right after the lead, before History/Demographics/Course of Events) rather than getting relocated to the end during QA's edits.
- Extend this same content-definition question to the Person template — Person currently starts directly at "Early Life," with no Overview-equivalent scene-setter; decide deliberately whether that's intentional (a person's significance is covered by the lead) or whether Person also needs a short Overview.

### 2.3 Tighten the "inline source hyperlink" rule to cut down on repetitive "according to X"
**Current behavior:** Content Rule 7 already says inline named-source attribution ("According to the Jewish Virtual Library...") should be used "sparingly" and "only when the source is explicitly named in the sentence." In practice, the trial-run articles use this pattern constantly — nearly every paragraph in the Moses and Six-Day War articles opens with "According to X" or "The [Source] notes/reports/states that..." The instruction to use it sparingly exists but isn't being followed, likely because the rule doesn't say *when not to* — it only says how to format it when used.

**Recommended change:**
- Add explicit negative guidance to Rule 7: **default to citing via the footnote marker alone, with the claim written as a plain factual statement** ("Tel Aviv was founded in 1909.[^1]") rather than routing it through source-attribution phrasing. Reserve inline named-source attribution for cases where naming the source is doing real work: a disputed claim, an opinion/interpretation, an estimate or projection, exclusive/first reporting, or a claim that can't be independently confirmed and needs to be visibly hedged as "according to X."
- This should be framed as a house-style rule alongside Rule 6 (anti-repetition) — it's the same underlying problem (templated, repetitive prose) with a specific, fixable cause.
- No change needed to the References/source-list requirement — full source names still belong there regardless of how sparingly they're named in-line.

### 2.4 Rein in the Controversies section's tone and proportion, especially for Concept/Person topics tied to Jewish history
**Current behavior:** Content Rule 8 (house style) already instructs the agent to surface Jewish historical continuity material and not manufacture an artificial "opposing view" for balance. But the Moses article's "Controversies and scholarly debate" section reads as a full, forcefully-worded academic-skepticism section — multiple paragraphs asserting that core biographical and religious-tradition claims are "not independently verifiable," "contested in modern biblical scholarship," etc. — which is disproportionate next to the rest of the article and in tension with the house-style rule that's already there.

**Recommended change:**
- Add a concrete constraint to Rule 8 (or a new sub-rule): when a controversy/debate section is warranted (per the category template's "Controversies — conditional" section), it should be **brief and clearly secondary** — a short paragraph noting that certain claims rest on tradition/interpretation rather than independent verification, without re-litigating each contested point at length or using language that reads as undermining the subject's broader historical, religious, or cultural significance.
- Make explicit that controversy material should never be the *longest* section of an article, and should not dominate the framing of sections that aren't themselves about the controversy (i.e., keep hedging language out of the Legacy/Significance/History sections and confine it to the dedicated Controversies section).
- This is consistent with, not a reversal of, the existing house-style stance in Rule 8 — it just needs to be stated as a proportionality constraint, not only a "don't manufacture false balance" constraint.

---

## 3. QA Agent

**File:** `IsraelPedia QA Agent Spec.md`

### 3.1 Make "unused bundle material" a first-class, systematic check — not just a fallback for missing sections
**Current behavior:** the spec already allows QA to draft a missing section from unused bundle material (Rule 1: "Drafting a missing required section from substantial unused bundle material," logged as `section_drafted`) and to rewrite a wrong claim using unused facts (Rule 1, Rule 5). The trial runs show this mechanism *does* fire — e.g. the Israel article's "Economy and culture" and "Notable sites" sections, and the Six-Day War's "Background" section, are explicitly logged as `section_drafted` from unused bundle material. So the mechanism isn't dead, but it's currently **triggered only when a required section is entirely missing** — it is not used proactively to thicken *existing* thin sections or to add missed context to a section that technically exists but underuses the bundle.

**Recommended change:**
- Broaden Rule 1's auto-fixable list (and the corresponding prompt section) so that reviewing unused bundle material is a standard step of every QA pass, not just a repair triggered by a missing-section gap. Add an explicit check: *"After completing citation verification, scan the facts and distinctive_material the Writing Agent did not use. Where any of it would meaningfully strengthen an existing section (added context, a stronger quote, a relevant date or figure) without requiring restructuring, incorporate it and log it as `content_rewrite`."*
- Keep the existing guardrail from the comment explicit in the rule: **this is not license to pad for word count.** QA should only pull in unused material that genuinely improves completeness, accuracy, or context — not material added merely to hit the new word-count target (see 3.2 below). Consider adding a line to Rule 1 or the "Explicit non-criterion" section (Rule 10) stating this directly, so it isn't left implicit.

### 3.2 Add a word-count check to the verification pass
**Current behavior:** the QA spec's Rule 7 (Length, formatting, and opening conformance) checks character limits on title, headings, lead, and per-paragraph splitting — but has no check against a total article length target, because the Writing Agent spec doesn't define one either (see 2.1 above).

**Recommended change:**
- Once the Writing Agent spec adds a target word-count range (1,000–3,000 words, scaled to bundle richness), add a corresponding QA check: if the article falls meaningfully short of what the bundle could support (i.e., there's substantial unused material and the article is well under the target), that's a legitimate opportunity to apply 3.1's broadened unused-material review — not a hard reject, but a routine trigger to look harder for enrichment opportunities before passing.
- If the bundle is genuinely thin and the article is short *because there's nothing more to say*, that's correct behavior and should pass as-is — the check should look at "is there unused, usable material," not just "is the word count low."

### 3.3 Add a proportionality check for controversy/debate sections
**Current behavior:** Rule 10 (explicit non-criterion) protects the house-style point of view from being flagged or "corrected" in the neutral direction, and correctly limits QA's intervention to cases where the article *contradicts* the bundle or abandons house style. It doesn't currently address the opposite failure mode seen in the Moses trial run — a controversies section that's accurate and grounded, but disproportionately long/forceful relative to the rest of the article.

**Recommended change:**
- Add a check under house-style conformance (Rule 8) alongside the existing terminology checks: if a Controversies/debate section is disproportionate in length or tone relative to the rest of the article (per the new Writing Agent proportionality rule in 2.4), QA should be able to trim/condense it using the same grounded-editing standard applied everywhere else — it's a proportionality and framing fix, not a fact-accuracy fix, but it's mechanical enough (compare section length/tone to the rest of the article) that it doesn't need to be escalated to a human the way a genuinely subjective political framing call would.
- Keep the existing hard boundary intact: QA still cannot alter what a *specific* contested claim says, or decide which side of a genuine editorial dispute is correct — this is only about section proportion and tone, not content selection.

---

## Summary table

| Area | Agent | Change |
|---|---|---|
| **Section ordering (new)** | **QA (and Writing)** | **Rewritten/redrafted sections must be applied in their correct template position, not appended to the end of the article — see section 0** |
| Extraction depth | Research | Replace one-line atomic facts with substantive per-source notes; scale depth to source richness |
| Article length | Writing | Add explicit 1,000–3,000 word target scaled to bundle richness; expose word count in output |
| Article length | QA | Check word count against bundle richness; use as a trigger (not a mandate) for unused-material review |
| Intro length | Writing | Raise the lead's own character cap (~900→1,200 single-paragraph; ~1,500→2,000–2,200 two-paragraph) |
| Structure | Writing | Define distinct content for "Overview" (significance/themes) vs. "Background" (lead-up context) instead of treating them as interchangeable; decide per-category whether a section needs one, the other, or both |
| Unused material | QA | Make unused-bundle-material review a standard step, not just a missing-section fallback; guard against padding |
| Attribution style | Writing | Default to footnote-only citation; reserve "according to X" phrasing for disputed/opinion/estimate/exclusive claims |
| Controversy framing | Writing | Keep controversy/debate sections brief and clearly secondary; don't let hedging bleed into other sections |
| Controversy framing | QA | Add a proportionality check on controversy sections, separate from the existing point-of-view protections |
