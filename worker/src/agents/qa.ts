/**
 * IsraelPedia QA / Fact-Checker Agent.
 *
 * Reviews a finished article against the research_bundle it was written from
 * and independently re-verifies every cited source by fetching the actual
 * page (fetch_url tool, deduped per unique URL, one retry then
 * source_unverifiable). It fixes what it finds — of any size — as long as the
 * fix is grounded in the bundle or a verified source, and escalates
 * (flag/reject) only what would require invention or a subjective editorial
 * call.
 *
 * Model: OpenAI GPT-5.6 (Sol — flagship reasoning tier; verified against
 * https://developers.openai.com/api/docs/models, July 2026) via the Responses
 * API with reasoning effort "high". Run only at this stage, not on bulk
 * writing volume. Tool-call rounds are chained with previous_response_id so
 * the model keeps its reasoning state between fetches.
 *
 * Output: a QAReport — verdict, edited_article (the corrected full article),
 * changes[] (audit log of every fix), issues[] (only what QA could NOT fix).
 */
import type { ResearchBundle } from "./research";
import type {
  ArticleReference,
  ArticleSection,
  WrittenArticle,
} from "./writing";
import { countArticleWords, toTitleCase } from "./writing";
import { fetchPageText, PageFetchResult } from "../lib/fetch-page";
import { withRetry, isRetryableError } from "../lib/retry";
import { parseLenientJson } from "../lib/lenient-json";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const QA_MODEL = "gpt-5.6";
const REASONING_EFFORT = "high";
/** Bound on total output (incl. reasoning) tokens per API round. */
const MAX_OUTPUT_TOKENS = 32_000;
/** Hard ceilings so a misbehaving run can't loop forever. */
const MAX_ROUNDS = 25;
const MAX_TOOL_CALLS = 40;
/**
 * Per-round timeout. High reasoning effort over an article + several fetched
 * pages legitimately takes minutes — but a dead connection must not hang the
 * run forever.
 */
const API_TIMEOUT_MS = 15 * 60_000;
/** Cap on page text handed back to the model per fetch — controls token cost. */
const MAX_QA_TEXT_CHARS = 15_000;

/**
 * Window a long page down to the model's budget. With a `find` query, return
 * the passage around the first match (plus the document head for context) so a
 * fact deep in a long page or PDF isn't lost to top-only truncation; without
 * one, fall back to head truncation.
 */
function windowText(full: string, find?: string): string {
  if (full.length <= MAX_QA_TEXT_CHARS) return full;
  if (find) {
    const needle = find.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
    const idx = needle ? full.toLowerCase().indexOf(needle) : -1;
    if (idx >= 0) {
      const headLen = 2000;
      const radius = Math.floor((MAX_QA_TEXT_CHARS - headLen) / 2);
      const start = Math.max(headLen, idx - radius);
      const end = Math.min(full.length, idx + radius);
      return (
        `${full.slice(0, headLen)}\n[...]\n${full.slice(start, end)}\n` +
        `[...document truncated; the excerpt above is the region matching your "find" query...]`
      );
    }
  }
  return (
    `${full.slice(0, MAX_QA_TEXT_CHARS)}\n[...truncated at ${MAX_QA_TEXT_CHARS} characters — ` +
    `if the fact you need is deeper in the page, call fetch_url again with a "find" argument...]`
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type QAVerdict = "pass" | "pass_with_edits" | "flag" | "reject";
export type RejectTarget = "writing_agent" | "research_agent";

export type QAChangeType =
  | "citation_fix"
  | "char_limit_trim"
  | "terminology_correction"
  | "claim_removed"
  | "content_rewrite"
  | "section_drafted"
  | "structural_fix"
  | "other";

export type QAIssueType =
  | "citation_untraceable"
  | "source_mismatch"
  | "source_unverifiable"
  | "internal_contradiction"
  | "overclaiming"
  | "structural_missing_section"
  | "style_drift"
  | "char_limit_exceeded"
  | "generic_template"
  | "other";

export interface QAChange {
  section: string | null;
  change_type: QAChangeType;
  before: string;
  after: string;
  reason: string;
}

export interface QAIssue {
  type: QAIssueType;
  section: string | null;
  description: string;
  severity: "low" | "medium" | "high";
}

export interface QAReport {
  verdict: QAVerdict;
  /** Only present when verdict is "reject". */
  reject_target?: RejectTarget;
  confidence: number;
  /** The corrected full article; null on reject. */
  edited_article: WrittenArticle | null;
  /** Audit log of everything QA fixed itself. */
  changes: QAChange[];
  /** Only UNRESOLVED problems QA could not fix itself. */
  issues: QAIssue[];
  summary: string;
}

export interface ComparisonArticle {
  title: string;
  summary: string;
  sections: { heading: string }[];
}

export interface QAInput {
  article: WrittenArticle;
  research_bundle: ResearchBundle;
  /**
   * Optional — supplied by a search/embedding layer we don't have yet. When
   * absent the model skips the genericness/novelty check (per spec).
   */
  comparison_articles?: ComparisonArticle[];
}

// ── System prompt (production prompt from the spec — verbatim) ───────────────

const SYSTEM_PROMPT = `You are the QA / Fact-Checking Agent for IsraelPedia. You review a completed article against
the research_bundle it was written from, and you independently verify every citation by
fetching the actual source page — you do not just check that the article agrees with the
bundle, you check that the bundle was right in the first place.

You fix what you find — of any size, not just small mechanical issues — as long as the fix is
fully grounded in the bundle (including facts the Writing Agent didn't originally use) or a
source you verified yourself. The line is grounded vs. ungrounded, not small vs. big: you can
rewrite a wrong passage, correct a structurally important claim, or draft a missing section,
provided you're using material that's actually there. You only stop and escalate when a fix
would require inventing unsupported content, or making a subjective editorial/political call.

You are bound by the exact same rules as the Writing Agent whenever you edit: cite only from
the research_bundle or a verified source, never fabricate, respect all the length/formatting
limits, and follow the house style below. Fixing something never means inventing content —
but it does mean using everything the bundle actually gives you, not just the parts the
Writing Agent happened to use.

You have a fetch_url tool. Use it once per unique source_url cited in the article (dedupe —
if multiple footnotes cite the same source, fetch it once).

## Verification method — for every footnoted claim

1. Identify its specific assertions: entities, numbers, dates, direct quotes,
   characterizations. "Founded in 1909" asserts a specific year — treat that precision as
   part of the claim, not just "founded at some point."
2. Find the bundle fact(s) the footnote's [^n] traces to, via references[n-1]. A missing,
   dangling, or mismatched marker is fixable directly.
3. Compare the article's assertions against the bundle fact's assertions. Flag invented
   precision — the article stating something more specific or different than the bundle
   supports.
4. Fetch the source (deduped) and compare both the bundle fact and the article's claim
   against what the source page actually says. If the source does not support it, that is a
   source_mismatch, regardless of whether the article and bundle agree with each other — the
   bundle itself can be wrong.
5. Direct quotes must be verbatim against the source (whitespace/punctuation normalization
   allowed) — flag any quote that is not exact.
6. When a claim turns out wrong, look for a correct replacement before deleting it. Check
   whether the bundle has other facts, used or unused by the Writing Agent, that accurately
   cover the same point. If so, rewrite the claim using that material instead of deleting it.
   Deletion is the fallback when nothing in the bundle can replace what was wrong — not your
   default response to every inaccuracy.

If a source does not verify on the first fetch, do NOT jump to source_unverifiable — exhaust
these steps first:
- The fetch_url tool reads PDFs as well as HTML, and accepts an optional "find" argument. If a
  fact is likely deep in a long page or PDF, call fetch_url again with "find" set to a short
  quote or phrase from the claim, so the tool returns the passage around it instead of only the
  top of the document.
- Look in the research_bundle for a DIFFERENT allowlisted source that supports the same fact.
  If one exists, fetch and verify against that instead, and record the substitution in
  changes[] (the citation may need to point at the working source).
Only after a genuine fetch failure (dead link, paywall, timeout, blocked) AND no working
alternate source remains is a claim source_unverifiable. Mark it so rather than treating it as
proof the claim is wrong — this is a technical access problem, not evidence of inaccuracy, and
it is NEVER grounds to delete or weaken the claim. Then apply this policy: if the claim is
structurally important (a load-bearing fact, a central figure/event/number/date), flag it for
human review; if it is peripheral, the article may pass with a logged source_unverifiable
issue. If most sources in the article are unverifiable, flag that on its own.

## Preserving sections — never remove a whole section in one action

This is a hard rule, and violating it is the single most common way this agent has damaged
articles. Removing or emptying an entire section is NOT an action you may take directly, and
neither is collapsing several of the Writing Agent's sections down into fewer. Well-sourced
content the Writing Agent included must survive your review. Work strictly at the claim level:

- Evaluate each claim in a section individually (verification method above). Before removing
  anything, attempt a content_rewrite from other bundle material (used or unused). Only the
  specific unsupported claim(s) may be removed — never the surrounding section.
- A section may end up empty ONLY as the eventual result of every one of its claims failing
  verification with no bundle replacement available. At that point — and only then — the
  "remove an empty section" fix applies, as a consequence of claim-by-claim review, never as a
  direct decision to cut or merge away the section.
- If a section is weak because the BUNDLE is thin on that topic (e.g. "historical Jewish
  presence" in a city article), that is a research gap, not grounds for deletion: keep what is
  there and flag it — or reject with reject_target "research_agent" if the gap is central — so
  the section gets properly resourced rather than cut.
- The category section template is a MINIMUM and an ordering guide, not a cap. If the Writing
  Agent included well-sourced sections beyond the template's named ones, KEEP them; do not drop
  or fold a sourced section merely because it is "off-template."
- Log section-level work claim by claim in changes[]: show which specific claims you kept,
  rewrote, or removed and why — not a single blanket "section removed" entry.

## Other checks

- Internal contradiction: cross-reference any specific fact (date, number, name, count) that
  appears more than once in the article (lead, sections, anywhere). Resolve using whichever
  value the bundle and verified source actually support, even if that means rephrasing more
  than one sentence.
- Overclaiming: restore the bundle's own hedge language when the article states a hedged fact
  ("some historians believe," "reportedly") flatly. But reasonable interpretation of sourced
  facts is fine and needs no fix — a documented event called a "turning point," documented
  methods an "early proof of concept" — so act ONLY when wording adds a new factual proposition
  or a categorical claim of causation, priority, exclusivity, or consensus the bundle doesn't support.
- Structural completeness: the article should cover its category's section template as a
  MINIMUM (Person: Early Life / Career / Legacy / Controversies; Place: Overview / History /
  Demographics / Economy & Culture / Notable Sites; Event: Background / Course of Events /
  Aftermath / Historiography; Concept: Overview / Origins / Practice / Significance /
  Controversies). If a template section is missing and the bundle has substantial unused
  material for it, draft the section yourself rather than just flagging the gap. The template
  is a floor, not a ceiling — additional well-sourced sections are welcome and must be kept
  (see "Preserving sections" above).
- Section order and in-place editing: edited_article.sections MUST preserve the category
  template's section order (the same order the Writing Agent's template defines). When you
  rewrite an existing section (content_rewrite) or draft a missing one (section_drafted),
  apply the change to that section's correct position in the sections array — a rewritten
  section is edited IN PLACE, keeping its existing anchor_id, and a newly drafted section is
  inserted at its template position. Never append a corrected or drafted section as a trailing
  extra entry at the end of the array, and never leave a stale "before" copy of a section you
  rewrote sitting in the array next to the new version.
- Unused bundle material (run this on EVERY pass, not only when a section is entirely
  missing): after completing citation verification, scan the facts and distinctive_material
  the Writing Agent did not use. Where any of it would meaningfully strengthen an existing
  section — added context, a stronger quote, a relevant date or figure — without requiring
  restructuring, incorporate it and log it as content_rewrite. This is not license to pad:
  only pull in unused material that genuinely improves completeness, accuracy, or context,
  never material added merely to hit a length or word-count target.
- Article length vs. bundle richness: the article should aim for roughly 1,000-3,000 words,
  scaled to how much usable material the bundle contains. If the article falls meaningfully
  short of what the bundle could support — i.e. there is substantial unused bundle material
  and the article is well under that range — treat that as a trigger to look harder for
  enrichment via the unused-bundle-material check above, not as a hard reject. If the bundle
  is genuinely thin and the article is short because there is nothing more to say, that is
  correct and passes as-is; judge "is there unused, usable material," not "is the word count
  low."
- Length and formatting limits: title <=75 chars; section headings 3-75 chars, Title Case
  (capitalize the first letter of every word except minor words like of/and/the/in/to; fix any
  heading that isn't), never restating the article's own title; lead (summary) 250-1,200 chars (<=2,200 across at
  most 2 paragraphs if extended); section body >=150 chars or it shouldn't exist; paragraphs
  within a section split at ~1,000 chars; footnote stacking <=2 markers per claim; inline
  hyperlink anchor text 3-60 chars; reference source_name 3-100 chars.
- Opening conformance: the lead's first sentence must follow the category-specific
  Wikipedia-style definitional pattern (bolded subject name + defining clause), not a
  distinctive_material hook.
- House-style conformance (see rules below).
- Genericness/novelty: only if comparison_articles was supplied, check whether the opening
  and structure reads as a near-duplicate template. If not supplied, skip this check. This one
  is always flagged, never fixed by you, even under your expanded mandate.

## What you can fix directly (apply the fix, record it in changes[])

- Length/formatting overflows anywhere in the limits above — trim, rephrase, or insert
  paragraph breaks without changing meaning or inventing content.
- An opening that doesn't follow the required definitional pattern — rewrite the first
  sentence using facts already present elsewhere in the article.
- Broken citation markup — a [^n] footnote pointing to a missing or wrong references[] index,
  or a claim missing a footnote it should have.
- House-style terminology corrections where the underlying bundle fact already supports the
  correction (e.g. "militant" -> "terrorist" when the cited source already characterizes it
  that way).
- In-prose source naming on ordinary facts: convert "According to [Source], <fact>[^n]" or
  "The [Source] notes/reports/describes/records that <fact>[^n]" into a plain statement carrying
  the [^n] footnote alone (log as terminology_correction). Keep in-prose attribution ONLY for a
  fact the bundle marks opinion_only / opinion_commentary, or a genuinely contested claim.
- Rewriting a factually wrong claim, of any structural importance, using other bundle facts
  (used or unused by the Writing Agent) that hold up — not just deleting it. Only delete when
  there is genuinely nothing in the bundle to replace it with.
- Drafting a missing required section from substantial unused bundle material, when the
  bundle actually has enough for it. Log this as section_drafted so a human can see it clearly
  even though you did not need to ask permission.
- Enriching an existing but thin section with unused bundle material (facts or
  distinctive_material the Writing Agent left unused) that adds real context, a stronger
  quote, or a relevant date/figure — edited in place, logged as content_rewrite. This is not
  license to pad for length: only add material that genuinely improves accuracy, completeness,
  or context.
- Resolving internal_contradiction and overclaiming even when it requires real synthesis, not
  just picking between two literal values, as long as it is grounded in the bundle.
- Minor structural fixes — renaming a heading to match its category's template naming, or
  removing a section only after claim-by-claim review has left it genuinely empty (never as a
  direct cut of a section that still has sourced content — see "Preserving sections" above).

## What you must flag or reject instead — never patch these yourself

- A controversy-flagged point, or a politically/editorially sensitive framing call, forces a
  flag to a human ONLY when it is material — apply this test. Escalate when the point is:
  (a) central/load-bearing to the article (the article's main claims depend on it), (b) an
  unresolved factual disagreement BETWEEN the bundle's own sources, or (c) a genuine framing
  judgment call with no clear house-style answer. A controversy_flag that is peripheral,
  presented accurately, and well-hedged per the bundle's own language does NOT by itself force
  a flag — the flag already did its job by making you scrutinize the point carefully; it does
  not also have to trigger human review every time. This is not license to resolve a material
  dispute yourself: you may present a flagged point accurately, but deciding which side is
  right, or making the subjective editorial call, remains a human's decision. "Nearly every
  article contains something sensitive" is exactly why a blanket escalation is useless — flag
  the genuinely load-bearing disputes, pass the routine ones.
- A content gap the bundle genuinely has no material to fill accurately (not just "this would
  take real work") -> flag if minor enough to publish without it, or reject with
  reject_target "research_agent" if central enough that the topic needs more research.
- Multiple source_mismatch findings indicating the bundle itself is unreliable -> reject with
  reject_target "research_agent" — no amount of rewriting fixes a broken foundation.
- The draft is mostly fabricated / does not trace to the bundle at all -> reject with
  reject_target "writing_agent" — cleaner to regenerate than rebuild piecemeal.
- Genericness/novelty findings (only when comparison_articles is supplied) — always raise
  these as an issue, never attempt to fix them, even under your expanded mandate.

## House style rules (same as given to the Writing Agent)

- "Terrorist" / "terrorism" for an act or actor the bundle's sources characterize that way,
  not softened to "militant," "fighter," or "activist."
- The 1948 war referred to primarily as the "War of Independence."
- West Bank / Judea and Samaria: on the article's first mention of the territory, the phrasing
  must assert the indigenous origin — "the West Bank — known by its original, indigenous Jewish
  name of Judea and Samaria" (or an equivalent construction). If the article reverts to a plain
  "West Bank" with no such acknowledgment on first mention, correct it, the same way you correct
  "militant" -> "terrorist." After the first mention either term may be used as context fits
  (contemporary/political -> "West Bank"; historical/biblical/continuity -> "Judea and Samaria").
- Jewish historical continuity / indigeneity material from the bundle should be present, not
  trimmed away.
- Israeli achievements documented in the bundle should be surfaced where topically relevant.
- No requirement to manufacture an "opposing view" for balance on contested points.
- Controversy notability: only mainstream disagreements, significant public controversies, or
  genuine scholarly debates warrant controversy treatment. A trivial or minor discrepancy
  (e.g. a small genealogical or textual detail, like whether a figure had six or seven
  siblings) is not encyclopedically notable — condense or remove it as a proportionality fix.
  Such trivia is NOT the kind of bundle-flagged controversy the preservation rules protect.
- Controversy-section proportionality: if a Controversies or debate section is
  disproportionately long or forceful relative to the rest of the article, condense it to be
  brief and clearly secondary, using the same grounded-editing standard applied everywhere
  else (log it as content_rewrite or structural_fix), and keep hedging language ("contested,"
  "not independently verifiable") confined to that section and out of the Legacy /
  Significance / History sections. This is a proportionality and framing fix only — you still
  may NOT change what a specific contested claim says, remove a controversy the bundle
  flagged, or decide which side of a genuine editorial dispute is correct; those remain
  flag-to-a-human calls.
- None of this licenses inaccuracy — every claim must still trace to the bundle and hold up
  against the verified source.
- The point of view itself is never grounds for a flag, reject, or "correction" in the
  opposite direction. Only correct or flag when the article contradicts the bundle/source or
  abandons the house style entirely.

## Verdicts

- pass: no issues found. edited_article is identical to the input article.
- pass_with_edits: you fixed one or more issues within your mandate — including substantial
  rewrites and drafted sections, not just mechanical trims. edited_article is the corrected
  version, changes[] documents what you did. Ready to publish, no human needed.
- flag: you fixed everything you could ground in the bundle/verified sources, but at least one
  remaining issue needs a human's judgment. Routes to a human review queue along with your
  partially-corrected edited_article and the remaining issues[]. Reserve flag for genuinely
  MATERIAL problems a human must resolve — a load-bearing dispute, a structurally important
  claim you could not verify, a subjective editorial/framing call. Your default successful
  outcome is pass_with_edits: if you were able to fix or ground everything, do not flag. Do NOT
  flag routine, peripheral, cosmetic, or already-resolved matters, and do not flag just because
  the topic is sensitive — over-flagging makes the review queue useless. When in doubt on a
  minor point, resolve it and pass_with_edits rather than escalating.
- reject: too broken to patch even with your full editing mandate. Omit edited_article. Set
  reject_target to "writing_agent" if the bundle is fine and only the draft needs
  regenerating, or "research_agent" if source verification showed the bundle itself is
  unreliable.

## Output format

Return ONLY a single JSON object, no prose before or after it:

{
  "verdict": "pass" | "pass_with_edits" | "flag" | "reject",
  "reject_target": "writing_agent" | "research_agent" (only present when verdict is "reject"),
  "confidence": number,
  "edited_article": { same shape as the Writing Agent's article output, or omitted on reject },
  "changes": [
    { "section": string or null,
      "change_type": "citation_fix" | "char_limit_trim" | "terminology_correction" |
        "claim_removed" | "content_rewrite" | "section_drafted" | "structural_fix" | "other",
      "before": string, "after": string, "reason": string }
  ],
  "issues": [
    { "type": "citation_untraceable" | "source_mismatch" | "source_unverifiable" |
      "internal_contradiction" | "overclaiming" | "structural_missing_section" |
      "style_drift" | "char_limit_exceeded" | "generic_template" | "other",
      "section": string or null, "description": string, "severity": "low" | "medium" | "high" }
  ],
  "summary": string
}

## Input you will receive

{
  "article": { the Writing Agent's article JSON output },
  "research_bundle": { the same bundle the article was written from },
  "comparison_articles": [ optional array of { title, summary, sections: [{ heading }] } ]
}`;

// ── fetch_url tool ────────────────────────────────────────────────────────────

const FETCH_URL_TOOL = {
  type: "function",
  name: "fetch_url",
  description:
    "Fetch a web page or PDF by URL and return its extracted readable text, for verifying a cited source. Handles both HTML and PDF sources. Call once per unique source_url — the result is deduped and cached.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The absolute URL of the source page or PDF to fetch",
      },
      find: {
        type: ["string", "null"],
        description:
          "Optional: a short quote or phrase from the claim you are verifying. On a long page or PDF, the tool returns the passage around this text instead of only the top, so a fact deep in the document isn't cut off by truncation. Pass null if not needed.",
      },
    },
    required: ["url", "find"],
    additionalProperties: false,
  },
  strict: true,
} as const;

/**
 * Execute one fetch_url call: dedupe the network fetch by URL across the whole
 * QA run (caching the FULL page text), retry once on transient failure (per
 * spec), then window the cached text to the model's budget — honoring the
 * optional `find` query so a different claim can target a different passage of
 * the same page without a re-fetch.
 */
async function executeFetchUrl(
  url: string,
  find: string | undefined,
  cache: Map<string, PageFetchResult>
): Promise<PageFetchResult> {
  const key = url.trim();
  let full = cache.get(key);

  if (full) {
    console.log(`[QA] fetch_url (cached): ${key}`);
  } else {
    let result = await fetchPageText(key);
    if (!result.ok && result.retryable) {
      console.warn(`[QA] fetch_url failed (${result.text}) — retrying once: ${key}`);
      result = await fetchPageText(key);
    } else if (!result.ok) {
      console.warn(`[QA] fetch_url failed (${result.text}) — not retrying (deterministic): ${key}`);
    }
    cache.set(key, result);
    full = result;
    console.log(`[QA] fetch_url: ${key} → ${result.ok ? "ok" : `FAILED (${result.text})`}`);
  }

  if (!full.ok) return full;
  // Window the cached full text per call (find may differ between claims).
  return { ...full, text: windowText(full.text, find) };
}

// ── OpenAI Responses API plumbing ─────────────────────────────────────────────

interface ResponsesOutputItem {
  type: string;
  // function_call items
  name?: string;
  arguments?: string;
  call_id?: string;
  // message items
  content?: { type: string; text?: string }[];
}

interface ResponsesApiResult {
  id: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
}

/**
 * One Responses API round, STREAMED. A non-streaming request that reasons for
 * many minutes returns no bytes until it finishes, which Node's HTTP stack can
 * silently stall on — with streaming the connection is live from the first
 * event, progress is logged as it happens, and a hard timeout bounds the
 * round. Transient failures are retried once by the caller-facing wrapper.
 */
async function callResponsesApiOnce(body: Record<string, unknown>): Promise<ResponsesApiResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Add it to worker/.env.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`OpenAI API error ${response.status}: ${errBody.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("OpenAI response had no body stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed: ResponsesApiResult | null = null;

    const handleEvent = (dataStr: string) => {
      if (dataStr === "[DONE]") return;
      let event: {
        type?: string;
        item?: { type?: string; name?: string };
        response?: ResponsesApiResult;
        message?: string;
      };
      try {
        event = JSON.parse(dataStr);
      } catch {
        return;
      }
      switch (event.type) {
        case "response.output_item.added":
          if (event.item?.type === "reasoning") {
            console.log("[QA]   …model is reasoning");
          } else if (event.item?.type === "function_call") {
            console.log("[QA]   …model is requesting a source fetch");
          } else if (event.item?.type === "message") {
            console.log("[QA]   …model is writing its report");
          }
          break;
        case "response.completed":
        case "response.incomplete":
          if (event.response) completed = event.response;
          break;
        case "response.failed":
          throw new Error(
            `OpenAI response failed: ${event.response?.error?.message ?? "unknown error"}`
          );
        case "error":
          throw new Error(`OpenAI streaming error: ${event.message ?? "unknown error"}`);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataStr = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (dataStr) handleEvent(dataStr);
      }
    }

    // Cast: TS's flow analysis can't see the assignment inside handleEvent.
    const data = completed as ResponsesApiResult | null;
    if (!data) throw new Error("OpenAI stream ended without a completed response");
    if (data.error?.message) {
      throw new Error(`OpenAI API returned an error: ${data.error.message}`);
    }
    if (data.status === "incomplete") {
      throw new Error(
        `OpenAI response incomplete (${data.incomplete_details?.reason ?? "unknown reason"})`
      );
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `OpenAI call exceeded the ${Math.round(API_TIMEOUT_MS / 60_000)}-minute round timeout`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Responses API with a few backoff-spaced retries on transient
 * failures (ECONNRESET / "terminated" mid-stream, 429, 5xx). A genuine
 * per-round timeout is NOT retried — retrying it would just burn another full
 * high-reasoning round.
 */
async function callResponsesApi(body: Record<string, unknown>): Promise<ResponsesApiResult> {
  return withRetry(() => callResponsesApiOnce(body), {
    label: `${QA_MODEL} QA call`,
    retries: 3,
    baseDelayMs: 3000,
    isRetryable: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/round timeout/i.test(message)) return false;
      return isRetryableError(err);
    },
  });
}

function extractOutputText(output: ResponsesOutputItem[]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

// ── Parsing / normalization ───────────────────────────────────────────────────

function extractJson(text: string): string {
  const stripped = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  if (stripped.startsWith("{")) return stripped;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return stripped;
  return text.slice(start, end + 1);
}

function kebab(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const CHANGE_TYPES: QAChangeType[] = [
  "citation_fix",
  "char_limit_trim",
  "terminology_correction",
  "claim_removed",
  "content_rewrite",
  "section_drafted",
  "structural_fix",
  "other",
];

const ISSUE_TYPES: QAIssueType[] = [
  "citation_untraceable",
  "source_mismatch",
  "source_unverifiable",
  "internal_contradiction",
  "overclaiming",
  "structural_missing_section",
  "style_drift",
  "char_limit_exceeded",
  "generic_template",
  "other",
];

/**
 * Coerce the model's edited_article into the WrittenArticle shape. If it is
 * missing or unusable on a non-reject verdict, fall back to the ORIGINAL
 * article (never lose the article) and warn loudly.
 */
function normalizeEditedArticle(
  raw: unknown,
  original: WrittenArticle
): WrittenArticle {
  if (!raw || typeof raw !== "object") {
    console.warn(
      "[QA] edited_article missing/unusable on a non-reject verdict — keeping the original article"
    );
    return original;
  }
  const parsed = raw as Record<string, unknown>;

  const sections: ArticleSection[] = [];
  if (Array.isArray(parsed.sections)) {
    for (const s of parsed.sections as Record<string, unknown>[]) {
      const heading = asString(s?.heading);
      const content = asString(s?.content);
      if (!heading || !content) continue;
      sections.push({
        heading: toTitleCase(heading), // enforce Title Case regardless of model output
        level: 2,
        anchor_id: asString(s?.anchor_id) ? kebab(asString(s?.anchor_id)) : kebab(heading),
        content,
      });
    }
  }
  if (sections.length === 0) {
    console.warn("[QA] edited_article had no usable sections — keeping the original article");
    return original;
  }

  const references: ArticleReference[] = [];
  if (Array.isArray(parsed.references)) {
    for (const r of parsed.references as Record<string, unknown>[]) {
      const url = asString(r?.source_url);
      if (!url) continue;
      references.push({
        source_name: asString(r?.source_name) || url,
        source_url: url,
        accessed_date: /^\d{4}-\d{2}-\d{2}$/.test(asString(r?.accessed_date))
          ? asString(r?.accessed_date)
          : new Date().toISOString().slice(0, 10),
      });
    }
  }

  const summary = asString(parsed.summary) || original.summary;

  return {
    title: asString(parsed.title) || original.title,
    category: original.category,
    summary,
    sections,
    see_also: [], // "See also" is intentionally not generated for now (editorial decision)
    references: references.length > 0 ? references : original.references,
    status: parsed.status === "stub" || original.status === "stub" ? "stub" : "complete",
    // Recompute from the corrected prose so the count stays authoritative.
    word_count: countArticleWords(summary, sections),
  };
}

// ── Content-preservation guard (enforces recommendation 3.1) ──────────────────
//
// The prompt tells QA never to drop a whole section, but a prompt alone did not
// hold (Hebron −34%, Holocaust −28%). This is the hard backstop: after the model
// returns its edited article, compare it to the original and restore any
// substantial section whose content vanished without being preserved elsewhere,
// then force the verdict to "flag" so a human sees it. Guarantee: QA can never
// silently make an article lose a section or a large fraction of its words.

/** Only guard sections with real content (below this they're negligible). */
const MIN_GUARDED_SECTION_CHARS = 200;
/** A dropped section counts as "preserved elsewhere" at/above this signature-hit ratio. */
const PRESERVE_THRESHOLD = 0.5;
/**
 * Aggregate word-loss thresholds. Only an EXTREME shrink forces a human flag —
 * a moderate one is just logged, so the guard doesn't over-escalate. (A dropped
 * whole section is handled separately and always flags.)
 */
const WORD_KEEP_RATIO_FLAG = 0.6; // kept < 60% (lost > 40%) → force flag
const WORD_KEEP_RATIO_WARN = 0.8; // kept < 80% (lost > 20%) → log only, no flag

function normHeading(h: string): string {
  return h.toLowerCase().replace(/\s+/g, " ").trim();
}

function articleText(a: WrittenArticle): string {
  return [a.summary, ...a.sections.map((s) => s.content)].join("\n");
}

/**
 * Distinctive tokens of a passage — years/numbers, quoted phrases, and
 * multi-word proper nouns — used to test whether the passage's substance
 * survived elsewhere in the edited article.
 */
function signatureTokens(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]{2,}/g)) {
    const n = m[0].replace(/,/g, "");
    if (n.length >= 3) set.add(n);
  }
  for (const m of text.matchAll(/["“”']([^"“”'\n]{6,60})["“”']/g)) {
    set.add(m[1].toLowerCase().replace(/\s+/g, " ").trim());
  }
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+/g)) {
    set.add(m[0].toLowerCase().replace(/\s+/g, " ").trim());
  }
  return [...set];
}

/** True if a dropped section's substance is still present in the edited text. */
function sectionContentSurvives(content: string, editedLower: string): boolean {
  const sigs = signatureTokens(content);
  if (sigs.length >= 2) {
    let hit = 0;
    for (const s of sigs) if (editedLower.includes(s)) hit++;
    return hit / sigs.length >= PRESERVE_THRESHOLD;
  }
  // Too few signature tokens to score — fall back to short-shingle overlap.
  const norm = content.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i + 40 <= norm.length && i < 600; i += 80) {
    if (editedLower.includes(norm.slice(i, i + 40))) return true;
  }
  return false;
}

/**
 * Restore any substantial section QA dropped without preserving its content,
 * and flag large aggregate word loss. Mutates `edited`, `changes`, and
 * `issues`; returns true if anything needs human review.
 */
function applySectionPreservationGuard(
  original: WrittenArticle,
  edited: WrittenArticle,
  changes: QAChange[],
  issues: QAIssue[]
): boolean {
  // Same object reference (edited fell back to the original) → nothing to guard.
  if (edited === original) return false;

  let needsHuman = false;
  const editedAnchors = new Set(edited.sections.map((s) => s.anchor_id));
  const editedHeadings = new Set(edited.sections.map((s) => normHeading(s.heading)));
  const editedLower = articleText(edited).toLowerCase();

  original.sections.forEach((orig, origIndex) => {
    if (orig.content.length < MIN_GUARDED_SECTION_CHARS) return;
    const matched =
      editedAnchors.has(orig.anchor_id) || editedHeadings.has(normHeading(orig.heading));
    if (matched) return;
    if (sectionContentSurvives(orig.content, editedLower)) return; // merged elsewhere — OK

    const insertAt = Math.min(origIndex, edited.sections.length);
    edited.sections.splice(insertAt, 0, { ...orig });
    editedAnchors.add(orig.anchor_id);
    editedHeadings.add(normHeading(orig.heading));
    console.warn(`[QA] Content-preservation guard: restored dropped section "${orig.heading}"`);
    changes.push({
      section: orig.heading,
      change_type: "structural_fix",
      before: `Section "${orig.heading}" present in the Writing Agent's article`,
      after: `Section "${orig.heading}" auto-restored by the QA content-preservation guard`,
      reason:
        "QA removed this well-sourced section without preserving its content or providing a " +
        "bundle-grounded replacement. Per the no-section-deletion rule it was restored " +
        "automatically and flagged for human review.",
    });
    issues.push({
      type: "other",
      section: orig.heading,
      description: `QA dropped the section "${orig.heading}" without preserving its content; it was automatically restored and needs human review.`,
      severity: "high",
    });
    needsHuman = true;
  });

  const originalWords = countArticleWords(original.summary, original.sections);
  const editedWords = countArticleWords(edited.summary, edited.sections);
  if (originalWords > 0 && editedWords < originalWords * WORD_KEEP_RATIO_FLAG) {
    // Extreme shrink with no dropped whole section → still a real problem.
    const pct = Math.round((1 - editedWords / originalWords) * 100);
    console.warn(
      `[QA] Content-preservation guard: edited article is ${pct}% shorter (${originalWords} → ${editedWords} words) — flagging`
    );
    issues.push({
      type: "other",
      section: null,
      description: `The QA-edited article is ${pct}% shorter than the Writing Agent's (${originalWords} → ${editedWords} words). Verify no sourced content was lost during editing.`,
      severity: "high",
    });
    needsHuman = true;
  } else if (originalWords > 0 && editedWords < originalWords * WORD_KEEP_RATIO_WARN) {
    // Moderate shrink — log for visibility but do NOT flag (avoid over-escalation).
    const pct = Math.round((1 - editedWords / originalWords) * 100);
    console.warn(
      `[QA] Content-preservation guard: edited article is ${pct}% shorter (${originalWords} → ${editedWords} words) — within tolerance, not flagging`
    );
  }

  // Keep word_count authoritative after any restores.
  edited.word_count = editedWords > 0 ? countArticleWords(edited.summary, edited.sections) : edited.word_count;
  return needsHuman;
}

// ── Footnote integrity: rebuild citation numbers from the final prose ─────────
//
// Recommendation §1: after QA edits (moving, rewriting, merging, or removing
// claims — and after the preservation guard restores any dropped section) the
// [^n] markers in the prose and the references[] array drift out of sync. The
// bibliography must be rebuilt from the FINAL article, not inherited
// mechanically from the draft. This does exactly that, deterministically:
//   • walk the prose in reading order (summary, then each section) collecting
//     every [^n] marker;
//   • renumber the cited sources sequentially by first appearance;
//   • drop orphan references — bibliography entries no marker points to (a
//     dropped/rewritten claim leaves its source behind);
//   • detect dangling markers — a [^n] with no matching reference. These can't
//     be auto-repaired (there is no source to attach), so they are left in place
//     and flagged for a human.
//
// It runs AFTER the section-preservation guard so any section that guard
// restored is included in the renumbering. A restored section carries the
// draft's original marker numbers; here they are made structurally consistent
// with the final bibliography, and the guard has already flagged that section
// for human review, so any residual mis-attribution is surfaced, not hidden.

interface FootnoteRebuildResult {
  /** True if numbering order changed or orphan references were dropped. */
  changed: boolean;
  /** Marker numbers found in prose with no backing reference (sorted). */
  danglingMarkers: number[];
}

const FOOTNOTE_MARKER_RE = /\[\^(\d+)\]/g;

function rebuildFootnotes(article: WrittenArticle): FootnoteRebuildResult {
  const oldRefs = article.references;
  // Prose blocks in reading order: the lead first, then each section body.
  const blocks: string[] = [article.summary, ...article.sections.map((s) => s.content)];

  // First-appearance order of marker numbers that resolve to a real reference,
  // plus any that don't (dangling).
  const firstSeenOrder: number[] = [];
  const seen = new Set<number>();
  const dangling = new Set<number>();
  for (const text of blocks) {
    for (const m of text.matchAll(FOOTNOTE_MARKER_RE)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= oldRefs.length) {
        if (!seen.has(n)) {
          seen.add(n);
          firstSeenOrder.push(n);
        }
      } else {
        dangling.add(n);
      }
    }
  }

  // old marker number -> new sequential number (by first appearance).
  const remap = new Map<number, number>();
  firstSeenOrder.forEach((oldN, i) => remap.set(oldN, i + 1));

  const orphanCount = oldRefs.length - firstSeenOrder.length;
  const reordered = firstSeenOrder.some((oldN, i) => oldN !== i + 1);
  const changed = orphanCount > 0 || reordered;

  if (changed) {
    // Rewrite every marker in a single pass per block — mapping old->new
    // atomically avoids a double-remap collision (e.g. 1->2 then 2->3).
    // Dangling markers have no mapping and are left untouched.
    const rewrite = (text: string) =>
      text.replace(FOOTNOTE_MARKER_RE, (whole, digits) => {
        const nn = remap.get(Number(digits));
        return nn ? `[^${nn}]` : whole;
      });
    article.summary = rewrite(article.summary);
    for (const s of article.sections) s.content = rewrite(s.content);
    // Rebuild the bibliography in the new order, dropping orphans.
    article.references = firstSeenOrder.map((oldN) => oldRefs[oldN - 1]);
  }

  return { changed, danglingMarkers: [...dangling].sort((a, b) => a - b) };
}

// ── Reference dedup: one bibliography number per source URL ───────────────────
//
// Recommendation §5 (dedup only — no URL normalization): when the same
// source_url appears under more than one bibliography number, the duplicates
// pad the bibliography and can imply independent corroboration that isn't there.
// Collapse them to the FIRST occurrence — rewrite every [^n] marker that points
// to a later duplicate so it points to the canonical entry instead. The now-
// uncited duplicate entries are removed by rebuildFootnotes (as orphans), which
// then renumbers — so this runs BEFORE it and only rewrites markers. URLs are
// compared exactly (already trimmed by normalizeEditedArticle); no canonicalization.

function dedupeReferences(article: WrittenArticle): boolean {
  const canonicalByUrl = new Map<string, number>(); // source_url -> its canonical number
  const remap = new Map<number, number>(); // later-duplicate number -> canonical number
  article.references.forEach((ref, i) => {
    const num = i + 1;
    const canonical = canonicalByUrl.get(ref.source_url);
    if (canonical === undefined) canonicalByUrl.set(ref.source_url, num);
    else remap.set(num, canonical);
  });
  if (remap.size === 0) return false; // every source_url is unique

  const rewrite = (text: string) =>
    text.replace(FOOTNOTE_MARKER_RE, (whole, digits) => {
      const to = remap.get(Number(digits));
      return to ? `[^${to}]` : whole;
    });
  article.summary = rewrite(article.summary);
  for (const s of article.sections) s.content = rewrite(s.content);
  return true;
}

function normalizeReport(raw: string, input: QAInput): QAReport {
  const parsed = parseLenientJson(extractJson(raw), "QA Agent report") as Record<
    string,
    unknown
  >;

  let verdict: QAVerdict =
    parsed.verdict === "pass" ||
    parsed.verdict === "pass_with_edits" ||
    parsed.verdict === "flag" ||
    parsed.verdict === "reject"
      ? parsed.verdict
      : "flag";
  if (verdict !== parsed.verdict) {
    console.warn(
      `[QA] Unrecognized verdict ${JSON.stringify(parsed.verdict)} — defaulting to "flag" for human review`
    );
  }

  let rejectTarget: RejectTarget | undefined;
  if (verdict === "reject") {
    rejectTarget =
      parsed.reject_target === "research_agent" ? "research_agent" : "writing_agent";
    if (parsed.reject_target !== rejectTarget) {
      console.warn(
        `[QA] reject verdict without a valid reject_target — defaulting to "writing_agent"`
      );
    }
  }

  const changes: QAChange[] = [];
  if (Array.isArray(parsed.changes)) {
    for (const c of parsed.changes as Record<string, unknown>[]) {
      const changeType = CHANGE_TYPES.includes(c?.change_type as QAChangeType)
        ? (c.change_type as QAChangeType)
        : "other";
      changes.push({
        section: asString(c?.section) || null,
        change_type: changeType,
        before: typeof c?.before === "string" ? c.before : "",
        after: typeof c?.after === "string" ? c.after : "",
        reason: asString(c?.reason),
      });
    }
  }

  const issues: QAIssue[] = [];
  if (Array.isArray(parsed.issues)) {
    for (const i of parsed.issues as Record<string, unknown>[]) {
      const description = asString(i?.description);
      if (!description) continue;
      issues.push({
        type: ISSUE_TYPES.includes(i?.type as QAIssueType)
          ? (i.type as QAIssueType)
          : "other",
        section: asString(i?.section) || null,
        description,
        severity:
          i?.severity === "low" || i?.severity === "high" ? i.severity : "medium",
      });
    }
  }

  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0.5;

  const editedArticle =
    verdict === "reject" ? null : normalizeEditedArticle(parsed.edited_article, input.article);

  // Deterministic backstops, run after the model returns:
  //  1. Section-preservation guard (rec. 3.1): never let QA silently drop a
  //     section or shed a large fraction of the article.
  //  2. Citation integrity (rec. §1 + §5 dedup): collapse duplicate source URLs
  //     to one bibliography number, then rebuild the claim↔footnote↔bibliography
  //     mapping from the final prose. Runs AFTER the guard so any restored
  //     section is included in the renumbering.
  if (editedArticle) {
    let needsHuman = applySectionPreservationGuard(
      input.article,
      editedArticle,
      changes,
      issues
    );

    const deduped = dedupeReferences(editedArticle); // must precede rebuildFootnotes
    const footnotes = rebuildFootnotes(editedArticle);
    if (deduped || footnotes.changed) {
      const parts: string[] = [];
      if (deduped) parts.push("collapsed duplicate source URLs to a single bibliography number");
      if (footnotes.changed)
        parts.push("renumbered footnotes by first appearance and dropped orphan references");
      console.log(`[QA] Citation integrity: ${parts.join("; ")}`);
      changes.push({
        section: null,
        change_type: "citation_fix",
        before: "Citation numbering and bibliography inherited mechanically from the draft.",
        after: `Citation integrity rebuilt from the final article: ${parts.join("; ")}.`,
        reason:
          "Deterministic post-QA pass that keeps the claim-to-footnote-to-bibliography mapping " +
          "consistent after editing (recommendation §1, and §5 URL dedup).",
      });
    }
    if (footnotes.danglingMarkers.length > 0) {
      const list = footnotes.danglingMarkers.map((n) => `[^${n}]`).join(", ");
      console.warn(
        `[QA] Footnote integrity: dangling marker(s) with no matching reference — ${list} (flagging)`
      );
      issues.push({
        type: "citation_untraceable",
        section: null,
        description:
          `Citation marker(s) ${list} reference a bibliography number that does not exist. ` +
          `They could not be repaired automatically (no source to attach) and need human review.`,
        severity: "high",
      });
      needsHuman = true;
    }

    if (needsHuman && (verdict === "pass" || verdict === "pass_with_edits")) {
      console.warn(
        `[QA] Guard triggered — upgrading verdict from "${verdict}" to "flag" for human review`
      );
      verdict = "flag";
    } else if ((deduped || footnotes.changed) && verdict === "pass") {
      // Dedup/renumber altered an otherwise-clean pass, so edited_article is no
      // longer identical to the input — the honest verdict is pass_with_edits.
      console.log(
        '[QA] Citation integrity changed an otherwise-clean "pass" — upgrading to "pass_with_edits"'
      );
      verdict = "pass_with_edits";
    }
  }

  return {
    verdict,
    ...(rejectTarget ? { reject_target: rejectTarget } : {}),
    confidence,
    edited_article: editedArticle,
    changes,
    issues,
    summary: asString(parsed.summary) || "(no summary provided)",
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run the QA Agent on one article + the bundle it was written from. Drives
 * the Responses API tool loop: each round either executes the model's
 * fetch_url calls (deduped, retried once) or receives the final QAReport.
 */
export async function runQA(input: QAInput): Promise<QAReport> {
  console.log(
    `[QA] "${input.article.title}" (${input.article.category}) — ` +
      `${input.article.sections.length} sections, ${input.article.references.length} references to verify`
  );

  const fetchCache = new Map<string, PageFetchResult>();

  const userPayload: Record<string, unknown> = {
    article: input.article,
    research_bundle: input.research_bundle,
  };
  if (input.comparison_articles && input.comparison_articles.length > 0) {
    userPayload.comparison_articles = input.comparison_articles;
  }

  const baseRequest = {
    model: QA_MODEL,
    reasoning: { effort: REASONING_EFFORT },
    instructions: SYSTEM_PROMPT,
    tools: [FETCH_URL_TOOL],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  let request: Record<string, unknown> = {
    ...baseRequest,
    input: [{ role: "user", content: JSON.stringify(userPayload) }],
  };

  let toolCalls = 0;
  let jsonRetryUsed = false;
  const startedAt = Date.now();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(
      `[QA] Round ${round + 1}: waiting on ${QA_MODEL} (high reasoning — this step can take several minutes; ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`
    );
    const response = await callResponsesApi(request);
    const output = response.output ?? [];
    const functionCalls = output.filter((item) => item.type === "function_call");

    if (functionCalls.length === 0) {
      const text = extractOutputText(output);
      if (!text) throw new Error("QA Agent response contained no output text");

      let report: QAReport;
      try {
        report = normalizeReport(text, input);
      } catch (err) {
        // jsonrepair already ran inside normalizeReport; only a truly garbled
        // report reaches here. Rather than re-run the whole expensive QA loop
        // (all the fetches + reasoning), ask the model to re-emit just the JSON,
        // reusing its reasoning state via previous_response_id — cheap and
        // one-shot. Any non-JSON error propagates.
        if (!(err instanceof SyntaxError) || jsonRetryUsed) throw err;
        jsonRetryUsed = true;
        console.warn(
          `[QA] Final report was not valid JSON even after repair (${err.message}) — asking the model to re-emit it once`
        );
        request = {
          ...baseRequest,
          previous_response_id: response.id,
          input: [
            {
              role: "user",
              content:
                "Your previous message was not valid JSON. Re-output the exact same QA report as a " +
                "SINGLE valid JSON object only — no prose, no code fences — and make sure every " +
                'double-quote inside a string value is escaped as \\".',
            },
          ],
        };
        continue;
      }

      console.log(
        `[QA] Verdict: ${report.verdict}` +
          (report.reject_target ? ` → ${report.reject_target}` : "") +
          ` (confidence=${report.confidence}) — ${report.changes.length} change(s), ` +
          `${report.issues.length} unresolved issue(s)`
      );
      return report;
    }

    const toolOutputs: Record<string, unknown>[] = [];
    for (const call of functionCalls) {
      toolCalls++;
      let outputPayload: Record<string, unknown>;

      if (call.name !== "fetch_url") {
        outputPayload = { ok: false, error: `Unknown tool "${call.name}"` };
      } else if (toolCalls > MAX_TOOL_CALLS) {
        outputPayload = {
          ok: false,
          error: `Tool-call budget (${MAX_TOOL_CALLS}) exhausted — mark any remaining unfetched sources as source_unverifiable and finish the report.`,
        };
      } else {
        let url = "";
        let find: string | undefined;
        try {
          const args = JSON.parse(call.arguments ?? "{}") as { url?: unknown; find?: unknown };
          url = asString(args.url);
          find = asString(args.find) || undefined;
        } catch {
          /* fall through to the error below */
        }
        if (!url) {
          outputPayload = { ok: false, error: "fetch_url called without a valid url argument" };
        } else {
          const result = await executeFetchUrl(url, find, fetchCache);
          outputPayload = result.ok
            ? { ok: true, url: result.url, page_text: result.text }
            : {
                ok: false,
                url: result.url,
                error: result.text,
                note: "Fetched twice, failed both times — treat this source as source_unverifiable, not as proof the claim is wrong.",
              };
        }
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(outputPayload),
      });
    }

    request = {
      ...baseRequest,
      previous_response_id: response.id,
      input: toolOutputs,
    };
  }

  throw new Error(`QA Agent did not finish within ${MAX_ROUNDS} tool rounds`);
}
