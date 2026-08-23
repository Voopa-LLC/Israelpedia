# IsraelPedia — Agent Revision Recommendations (Round 2)
*Based on editorial review of the current trial-run batch (including the Hebron and Holocaust articles) against the Research/Writing/QA Agent specs and the July 19 revision doc (`IsraelPedia Agent Revision Recommendations.md`).*

## Cross-cutting theme: some of this is new spec gaps, some of it is existing rules not landing in practice

Splitting the nine comments into two buckets matters, because they need different fixes:

**A. The spec is genuinely silent on this — needs a new rule.** Alternate-source lookup before giving up (#2), excluding opinion/blog content (#3), a terminology policy (#5), and proportional article depth by subject importance (#8) are all things no current spec addresses. These need new spec language.

**B. The spec already says the right thing, but the observed output isn't doing it.** Three of these are the concerning ones, because adding *more* spec text won't fix a prompt-adherence gap:
- Inline hyperlinks (#1) — the Writing Agent spec (Content Rule 7) already requires markdown links for named sources.
- Naming sources in prose (#4) — Content Rule 7 already says to do this "sparingly," and this exact complaint was raised on July 19 (item 2.3) with a spec fix recommended. If it's still happening, either that fix wasn't actually shipped, or the added negative guidance isn't sufficient on its own.
- QA over-deleting instead of rewriting (#6, #7) — the July 15 QA redesign and the July 19 doc's "unused bundle material" fix (item 3.1) already give QA explicit permission and instruction to rewrite/restore using bundle material instead of cutting. Two more articles showing the same failure mode suggests either the July 19 fix wasn't deployed to the live QA prompt, or QA has the permission in principle but isn't exercising it.

**Recommended first step for the developer, before touching any spec text further:** confirm which of the July 19 recommendations actually made it into the production system prompts currently running. If items 2.1, 2.3, and 3.1 from that doc were never deployed, several of today's complaints (#4, #6, #7, #8) are simply that fix still pending — not new problems requiring new design work. If they *were* deployed and the behavior persists anyway, that's a model-fidelity issue (the instruction exists but isn't being followed reliably), which may need stronger/more repetitive phrasing, a worked example specifically demonstrating the failure mode being avoided, or (for QA specifically) restructuring the prompt so "check for unused material" and "prefer rewrite over deletion" are unskippable steps rather than optional guidance.

---

## 1. Research Agent

**File:** `IsraelPedia Research Agent Spec.md` / `IsraelPedia Source Allowlist.md`

### 1.1 Exclude opinion/commentary content — this is bigger than just Times of Israel's blogs section
**Current behavior:** the allowlist includes `timesofisrael.com` at the apex domain, with no distinction between its reported news coverage and its blogs platform. Separately, the "Jewish Intellectual Journals" category (Mosaic, Sapir, *Jewish Review of Books*, Tradition, Hakirah) is *entirely* essay/commentary content by design — none of that is edited news reporting, so excluding "blogs" alone doesn't solve the underlying problem.

**Recommended change:**
- **Technical exclusion for Times of Israel specifically:** confirm at build time whether Perplexity's `search_domain_filter` treats `timesofisrael.com` as covering `blogs.timesofisrael.com` (its blogging platform's actual subdomain). If the filter is domain-wildcard-inclusive, either check for an exclusion syntax in the Sonar API, or add a post-fetch filter in the Research Agent's own validation step that rejects any URL under the blogs subdomain/path regardless of what the domain filter allowed through. Don't rely on the domain filter alone without verifying this.
- **Add a `source_type` field to every `facts[]` and `distinctive_material[]` entry:** `news | opinion_commentary | academic | official_record | reference | advocacy_research`. This lets Writing/QA treat opinion-sourced material differently without needing to hardcode per-domain logic everywhere downstream. The Jewish Intellectual Journals category, any op-ed URL pattern on a news site, and similar should be tagged `opinion_commentary`.
- **New Content Rule (Research Agent spec):** an `opinion_commentary`-tagged fact is not excluded outright (it's still useful — these are often exactly the sources with argument and interpretive context) but it must never be the sole source for a factual claim. If the Research Agent finds a fact only in an opinion source, either find a corroborating fact from a `news`/`academic`/`official_record` source, or explicitly note in the bundle that the fact rests solely on commentary (via a flag similar to `controversy_flag`) so the Writing Agent can attribute it as opinion rather than presenting it as settled fact.

### 1.2 Attempt an alternate accessible source before marking material unverifiable
**Current behavior:** neither this spec nor the QA spec currently has a "try again with a different source" step — a fetch failure (403/404/timeout) or an unreadable format (PDF, truncation) just gets marked unverifiable and moves on (see QA section 2.2 below; this is really a two-agent fix).
**Recommended change:** when the Research Agent's initial fetch of an allowlisted URL fails or the topic is thin, it should check whether the same fact is independently available from a *different* allowlisted source before giving up on it — not search the open web, still allowlist-only, just don't stop at the first source that happens to fail. Log which URL(s) were tried and which one ultimately succeeded, so QA and the developer can see the substitution happened rather than assuming the original citation is what's live in the bundle.

### 1.3 Depth should scale with subject significance, not just source richness
**Current behavior:** the July 19 fix (item 1.1) already recommended scaling extraction depth to *how much a given source contains*. That's necessary but not sufficient — it doesn't address a topic that matters a great deal (a major historical event, a foundational figure, a city with centuries of continuous significance) but where individual sources are each fairly terse. A dozen terse-but-relevant sources on a major topic should still produce a substantially deeper bundle than a dozen terse sources on a minor one.
**Recommended change:** add a `significance_tier` field to the bundle (`major | standard`), either passed down from the Topic List Agent (if it already has a sense of a topic's importance) or inferred by the Research Agent from signals like source count across categories, breadth of coverage, and controversy flag density. For `major` topics, the Research Agent should actively pursue broader coverage — more of the allowlist's categories (history, demographics, primary sources, academic centers), not just whichever sources surface first — rather than stopping once a "complete" bundle is technically assembled. This feeds directly into the Writing Agent's length target (2.3 below).

---

## 2. Writing Agent

**File:** `IsraelPedia Writing Agent Spec.md`

### 2.1 Hyperlinks: verify the mechanism is actually firing, not just specified
**Current behavior:** Content Rule 7 already requires that any source named in-line render as a markdown link (`[Jewish Virtual Library](url)`), and every claim gets a `[^n]` footnote marker that the frontend is expected to render as a link into the References section. If readers report "no clickable links," one of two things is happening: (a) the model isn't consistently emitting the markdown-link syntax even when naming a source, or (b) the frontend isn't rendering `[^n]` and `[text](url)` markdown into actual `<a>` tags.
**Recommended change:**
- Developer: check actual raw article JSON from a recent run for the presence of `[text](url)` and `[^n]` markup before assuming this is a prompt problem — if the markup is there and just isn't rendering, the fix is in the frontend renderer, not either agent spec.
- If the markup is genuinely absent from the model's output: add a QA check (see 3.1 below) that verifies every `references[]` entry has at least one corresponding inline markdown-link mention *or* is exclusively cited via footnote — and treat "a claim with no footnote and no inline link" as a formatting defect QA auto-fixes by inserting the missing footnote marker.

### 2.2 Reduce in-prose source naming — this is a repeat of the July 19 finding (item 2.3)
**Current behavior:** Content Rule 7 already instructs sparing use, reserved for cases where naming the source "is doing real work." The July 19 doc already flagged this exact pattern (excessive "According to X" phrasing) and recommended defaulting to footnote-only citation, reserving named attribution for disputed/opinion/estimate/exclusive claims. If this is still showing up across articles, treat it as unresolved from last round rather than a new issue.
**Recommended change:** if the July 19 wording change was deployed and this is still happening, strengthen Rule 7 with a concrete negative example list (the current rule states the exception cases but not what *not* to do) — e.g. explicitly show a "don't: 'According to the Jewish Virtual Library, Tel Aviv was founded in 1909.[^1]'" vs. "do: 'Tel Aviv was founded in 1909.[^1]'" pair in the system prompt, since models often follow a shown negative example more reliably than an abstract instruction. Also tie this to 1.1 above — some of what looks like source-naming overuse may really be attribution of `opinion_commentary`-tagged material, which *should* be named per the new Research Agent rule; distinguish "necessary attribution of a hedged/opinion claim" from "reflexive naming of a routine factual source" so the fix doesn't overcorrect against the legitimate case.

### 2.3 Terminology policy — West Bank / Judea and Samaria (decided)
**Editorial decision (2026-07-23):** not a neutral "also known as" formulation — the phrasing must make clear that Judea and Samaria are the region's original, indigenous Jewish names, consistent with the rest of the house style's stance on Jewish continuity/indigeneity (Rule 8).

**Recommended concrete rule for Content Rule 8 (Writing Agent) and the corresponding QA house-style check:**
- **First mention in an article:** *"the West Bank — known by its original, indigenous Jewish name of Judea and Samaria"* (or an equivalent construction the team wants to word-tune, but it must assert indigeneity/origin, not mere alternate naming).
- **Subsequent mentions in the same article:** either term may be used depending on context — "West Bank" reads more naturally in contemporary political/geographic/demographic content; "Judea and Samaria" fits historical, biblical, or Jewish-continuity content — rather than mechanically repeating the full first-mention phrase every time.
- Add this as a labeled sub-rule under Rule 8 (parallel to the existing "terrorist"/"War of Independence" entries) in both the Writing Agent's Content Rules and its production system prompt, and mirror it in the QA Agent's house-style section (Rule 8 / Rule 10) so QA can correct an article that reverts to plain "West Bank" with no acknowledgment of Judea and Samaria, the same way it already corrects "militant" → "terrorist."
- Per the existing note on Rule 8: this is still a first-draft formulation from an agent-spec-writing standpoint even though the *policy direction* is now decided — the team should sign off on the exact wording before it's locked into the production prompt.

### 2.4 Article length should scale with subject significance
**Current behavior:** the July 19 fix (item 2.1) recommended a flat 1,000–3,000 word target scaled to bundle richness. That doesn't yet account for subject *importance* independent of how much material happened to surface — see 1.3 above.
**Recommended change:** once the Research Agent exposes `significance_tier`, extend the Writing Agent's target-length rule (2.1's addition to Content Rule 5) to scale by tier — e.g. `major` topics targeting the top of the range or beyond (with no hard ceiling if the bundle genuinely supports more) and additional sections encouraged (deeper historical context, more granular "Significance"/"Legacy" treatment, more of the conditional sections used), while `standard` topics stay concise. The goal stated in the feedback is proportional depth, not a raised word-count floor for every article — thin/minor topics should still be allowed to stay short.

---

## 3. QA Agent

**File:** `IsraelPedia QA Agent Spec.md`

### 3.1 Stop deleting whole sections — enforce claim-level granularity before any section-level removal
**Current behavior:** Rule 1 already permits rewriting a wrong claim with bundle material instead of deleting it, and Rule 6 permits removing only "empty/padded" sections — a section with real, if imperfectly sourced, content isn't supposed to qualify for wholesale removal under the current rules. The Hebron (Jewish presence through the centuries) and Holocaust cases suggest QA is doing this anyway, at the section level rather than the claim level.
**Recommended change:**
- Add an explicit, hard rule: **QA may never remove an entire section in one action.** If a section has one or more problematic claims, each claim must be evaluated individually per Rule 1/Rule 5 — attempt `content_rewrite` using other bundle material (used or unused) first; only remove the *specific unsupported claim(s)*, not the section around them. A section may end up empty *as a result* of every individual claim failing verification with no replacement available — at that point Rule 6's "remove empty section" applies, but as a consequence of claim-by-claim review, never as a direct action.
- If a section's core material is unverifiable specifically because the *bundle* is thin on that topic (ties to 1.3/2.4 above — a section like "historical Jewish presence" in a city article deserves real depth, and a thin bundle may not have supplied it), that's a `research_agent`-targeted gap, not grounds for deletion — flag or reject-to-research per existing Rule 1 escalation criteria, so the section gets properly resourced rather than cut.
- Log every section-level change with enough detail in `changes[]` to show which individual claims were evaluated and why each one was kept, rewritten, or removed — not just a single "section removed" entry — so a human reviewing the audit trail can see the claim-by-claim reasoning, not just the outcome.

### 3.2 Attempt an alternate source before marking a citation unverifiable (QA side)
**Current behavior:** the fetch-failure handling (Requires tool/function-calling section) retries once, then marks `source_unverifiable` and moves on. PDFs currently aren't handled as a distinct case — "returned PDF data without readable claim text" implies the `fetch_url` tool's HTML-to-text extraction isn't handling PDF responses, so QA can't verify against them at all.
**Recommended change:**
- **PDF handling:** the `fetch_url` tool needs PDF-to-text extraction as a first-class case, not just HTML extraction — if a cited `source_url` resolves to a PDF, extract its text before attempting the comparison in Rule 2, rather than returning unparsed binary/PDF data.
- **Truncation:** if extraction stops mid-document before reaching the relevant passage, retry with a targeted extraction (e.g., search within the document for the claimed fact/quote rather than only reading from the top) before giving up.
- **Alternate-source fallback:** before finalizing `source_unverifiable`, check whether the research_bundle contains an alternate allowlisted source for the same fact (this is the QA-side half of 1.2 above — the Research Agent should try this proactively going forward, but QA is the backstop for bundles generated before that fix, or for facts where only one source existed). If a working alternate exists, verify against that instead and note the substitution in `changes[]`.
- **Policy for what remains genuinely unverifiable after all of the above:** this needs an explicit answer rather than defaulting silently to "publish with a low/medium-severity issue." Recommend: a claim backed only by an unverifiable source should be flagged for human review if it's structurally important (ties to existing Rule 5 distinction), but may pass with a logged `source_unverifiable` issue if it's peripheral — this is close to current behavior, but should be stated as an explicit decision rule rather than left implicit in "low/medium severity."

### 3.3 Narrow what triggers mandatory human review — flag should mean "genuinely needs judgment," not "contains anything sensitive"
**Current behavior:** Rule 1's escalation list sends *any* `controversy_flag`-marked material to `flag`, regardless of how central or disputed that specific point actually is within the article. Given how much of this project's subject matter touches politically or historically sensitive ground by nature, almost every substantive article is likely to contain at least one controversy-flagged fact somewhere — which is probably why all three trial articles were flagged, not just Hebron.
**Recommended change:**
- Distinguish **"the bundle contains a controversy-flagged fact that QA presented accurately and unremarkably"** from **"the article contains a live, unresolved, load-bearing dispute."** Only the latter should force `flag`. A controversy-flagged fact that is peripheral, well-hedged per the bundle's own language, and not central to the article's main claims can pass (or `pass_with_edits`) without human review — the controversy flag already did its job by making QA scrutinize it carefully; it doesn't need to *also* force escalation every time.
- Concretely: add a materiality test to Rule 1's escalation criterion — escalate when a controversy-flagged point is (a) central/load-bearing for the article (comparable to the existing "structurally important claim" test in Rule 5), (b) contested *between the bundle's own sources* (unresolved factual disagreement, not just a topic that's politically sensitive in general), or (c) a framing judgment call with no clear house-style answer. Routine, peripheral, or already-settled-by-the-bundle controversy flags should not, by themselves, force `flag`.
- This directly addresses the "if nearly every article is flagged, the warning isn't useful" problem — Hebron's political/historical sensitivity is dense enough that it should likely still flag under a materiality test; a routine topic with one minor, well-sourced, peripheral contested point should not.

---

## Summary table

| # | Area | Agent(s) | Status | Change |
|---|---|---|---|---|
| 1 | Hyperlinks missing | Writing (spec exists) / possibly frontend | Verify first | Check raw JSON for markup before assuming a prompt fix is needed; add QA check that every reference has a footnote or inline link |
| 2 | Sources 403/404/timeout/PDF/truncated | Research + QA | New | Try an alternate allowlisted source before giving up; add PDF extraction to `fetch_url`; retry truncated fetches with targeted search; explicit publish/flag policy for what's left unverifiable |
| 3 | Opinion/blog sourcing | Research | New | Exclude ToI blogs subdomain/path (verify domain-filter behavior); add `source_type` tagging across the whole allowlist (not just ToI); opinion-tagged facts need corroboration or explicit attribution, never sole basis for a claim |
| 4 | Sources named in prose | Writing (spec exists, repeat of July 19 item 2.3) | Verify first, then strengthen | Confirm July 19 fix shipped; if still happening, add concrete do/don't examples to Rule 7 |
| 5 | West Bank / Judea and Samaria | Writing + QA | New — decided 2026-07-23 | First mention asserts Judea/Samaria as the indigenous name; later mentions context-dependent; add to Rule 8 in both specs, pending final wording sign-off |
| 6, 7 | QA over-deleting sections (Hebron, Holocaust) | QA (spec already permits rewrite, repeat pattern) | Verify first, then harden | Hard rule against section-level deletion; claim-by-claim review only; thin-bundle-driven gaps route to research, not deletion |
| 8 | Articles too short/thin | Research + Writing (partial repeat of July 19 items 1.1/2.1) | Extend existing fix | Add `significance_tier`; scale both extraction breadth and target length by subject importance, not just bundle richness |
| 9 | Over-flagging for human review | QA | New | Add materiality test to the `flag` trigger — controversy-flagged ≠ automatically flag-worthy; only central/unresolved/judgment-call disputes should force human review |
