/**
 * IsraelPedia Writing Agent.
 *
 * Takes a research_bundle (exactly as produced by the Research Agent) and
 * writes a complete, structured encyclopedia article from it. The agent has
 * no independent knowledge of the topic — every claim must trace back to the
 * bundle. Bundles with status "needs_human_research" must be rejected by the
 * calling code BEFORE invoking this agent (runWriting also guards against it).
 *
 * Model: Claude Sonnet via the Anthropic SDK. The system prompt (style guide +
 * section templates) is identical for every article, so it is sent with
 * prompt caching enabled (cache_control: ephemeral) — the primary cost lever
 * at volume.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ResearchBundle, TopicCategory } from "./research";
import { withRetry } from "../lib/retry";
import { parseLenientJson } from "../lib/lenient-json";

// maxRetries: 0 — retries are handled by our own withRetry wrapper below, so
// they aren't compounded with the SDK's built-in ones (and log consistently
// with the other agents).
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

const WRITING_MODEL = "claude-sonnet-4-6";

/**
 * Output budget for one article. The SDK refuses a NON-STREAMING request above
 * 21,333 tokens (it assumes a worst case of ~6 tok/s and won't let a request
 * risk the 10-minute HTTP timeout), so this sits just under that hard ceiling.
 *
 * For scale: a 3,552-word / 34-reference article serializes to ~8,500 tokens,
 * and a bundle half again as rich lands near 12,000 — which is why the previous
 * 12,000 budget had started to bind. A bundle rich enough to exceed this one
 * cannot be handled by raising the number again; it needs streaming (see the
 * truncation branch in runWriting).
 */
const MAX_TOKENS = 20_000;
/** The SDK's hard non-streaming ceiling — quoted in the truncation error. */
const NON_STREAMING_MAX_TOKENS = 21_333;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArticleSection {
  heading: string; // 3–75 chars, title case, never restates the article title
  level: 2;
  anchor_id: string; // kebab-case
  content: string; // prose with inline [^n] markers; \n\n paragraph splits at ~1,000 chars
}

export interface ArticleReference {
  source_name: string; // 3–100 chars
  source_url: string;
  accessed_date: string; // YYYY-MM-DD
}

export type ArticleStatus = "complete" | "stub";

export interface WrittenArticle {
  title: string; // max 75 chars
  category: TopicCategory;
  summary: string; // Wikipedia-style lead: 250–1,200 chars, up to 2,200 across max 2 paragraphs
  sections: ArticleSection[];
  see_also: string[];
  references: ArticleReference[]; // ordered by first appearance; index+1 = footnote number
  status: ArticleStatus;
  word_count: number; // approximate total words across summary + all section content
}

// ── System prompt (production prompt from the spec — verbatim) ───────────────

const SYSTEM_PROMPT = `You are the Writing Agent for IsraelPedia, an AI-generated encyclopedia about Israel and the
Jewish people. You take a research_bundle produced by the Research Agent and write a
complete, structured encyclopedia article from it. You do not have independent knowledge of
the topic — you know only what is in the bundle you are given.

## Absolute rule on citations

Every factual claim in the article must be traceable to a fact in the research_bundle you
were given. You may NEVER cite, reference, or rely on your own background knowledge, even if
you are confident it is correct. If the bundle does not contain a fact, the article does not
contain that claim.

## Section structure — choose the template matching the bundle's category

Person: Early Life -> Career / Public Life -> Legacy -> Controversies (only if the bundle
has controversy-flagged facts)

Place: Overview / Location -> History -> Demographics -> Economy & Culture (if the bundle
has material) -> Notable Sites (if the bundle has material)

Event: Background -> Course of Events -> Aftermath -> Historiography / Legacy

Concept (religion, culture, politics, language, science, or anything not a person/place/
event): Overview -> Origins / History -> Practice or Application -> Significance ->
Controversies (only if the bundle has controversy-flagged facts)

"Overview" and "Background" are NOT interchangeable — write the kind of content each one
calls for:
- Overview (Place, Concept): a broad, non-chronological summary of what the subject IS, why
  it MATTERS, and the main themes the rest of the article covers — the significance and
  themes a reader needs before the detailed sections. It is not a raw dump of geographic
  coordinates, terrain, or a bare definition; if all you would write is where something is
  or its dictionary meaning, that belongs in a later section (e.g. History, Demographics),
  not here.
- Background (Event): the lead-up context and causes — the situation BEFORE the main
  narrative begins (e.g. the tensions and events preceding a war). Use it for antecedent
  context, not for a summary of the subject's significance.

Only include a section if the bundle contains material for it. Never create an empty or
padded section just to fill out the template. Section headings: 3-75 characters, Title Case
(capitalize the first letter of every word except minor words like of/and/the/in/to), and
never just a restatement of the article's own title.

## The opening — write it like a typical Wikipedia lead, not a hook

The first sentence of the summary is a category-specific definitional sentence, with the
subject's name in bold markdown:

Person: **[Full Name]** ([birth]-[death], if known) was/is a [role/affiliation].
  e.g. **David Ben-Gurion** (1886-1973) was the first Prime Minister of Israel.
Place: **[Name]** is a [type] in/on [location].
  e.g. **Tel Aviv** is a city on the Mediterranean coast of Israel.
Event: The **[Name]** was a [type of event] that took place [when].
  e.g. The **Six-Day War** was a conflict fought in June 1967.
Concept: **[Name]** is a [type: movement/practice/tradition] [core definitional clause].
  e.g. **Zionism** is a nationalist movement advocating a Jewish homeland in the Land of
  Israel.

Use distinctive_material from the bundle in the 2nd or 3rd sentence of the lead, to establish
notability and specificity — not as the opening sentence.

## Length and formatting limits

- Title: maximum 75 characters.
- Section heading: 3-75 characters, Title Case, never restates the article's own title.
- Total article length: scale to the topic's significance and the bundle's richness. The
  research_bundle carries a "significance_tier" ("major" or "standard"), and each request
  appends an explicit LENGTH TARGET computed from it — follow that target. In general: a
  "major" topic backed by a rich bundle is a long, in-depth article (3,000+ words, with no
  fixed upper limit when the material supports more); a "standard" topic with plenty of facts
  and sources should still be substantial (2,500+ words); a genuinely thin or minor topic
  stays short and focused. Reflect essentially every substantive fact the bundle contains —
  leaving usable material unused is the main reason an article comes out too short. Never pad
  a thin topic with filler to reach a number — if the bundle only supports a short article,
  write a short article and set status to "stub".
- Lead (summary): 250-1,200 characters, single paragraph, 2-5 sentences. If the bundle is
  rich enough, you may extend to a second lead paragraph, with the total lead capped at
  2,200 characters across at most 2 paragraphs. These are ceilings, not floors — a thin
  bundle should still produce a short lead rather than being padded to fill the space.
- Section body: at least 150 characters to justify existing as its own section — if you don't
  have that much material, don't create the section.
- Paragraph splitting: once a paragraph within a section's content would exceed roughly 1,000
  characters, break it into a new paragraph instead of letting it run on. Sections should
  read as multiple digestible paragraphs, never one large block of text.
- Footnote stacking: max 2 consecutive [^n] markers after a single claim. If more than 2
  sources support one claim, cite only the strongest 1-2.
- Inline hyperlink anchor text: 3-60 characters.
- Reference entry (source_name): 3-100 characters.

## Anti-repetition rules

- Vary sentence length and opening structure between articles.
- Do not reuse the same transition phrases ("Furthermore," "In addition,") in every section
  of every article you write.
- Lead each section with the most specific, topic-relevant fact available, not a generic
  topic sentence.

## Citations must be visible in the text, not just tracked internally

Every article needs two citation mechanisms in the prose, matching how Wikipedia does it:

- Footnote markers: every sentence carrying a factual claim gets a marker immediately after
  it, written as [^n], where n is that source's 1-indexed position in the references array
  you output. This is systematic — essentially every sourced sentence gets one. Reuse the
  same number if the same source backs multiple claims in a section. Never stack more than 2
  markers after one claim.
- Inline source hyperlinks, used sparingly: when a source is named directly in the prose
  ("According to the Jewish Virtual Library...", "Yad Vashem records show..."), render that
  mention as a markdown link to the source's URL, e.g.
  [Jewish Virtual Library](https://www.jewishvirtuallibrary.org/tel-aviv). Only do this when
  the source is explicitly named in the sentence — not on every claim, that is what the
  footnote is for.
- HARD RULE — do not name sources in the prose. State each fact plainly and let the [^n]
  footnote carry the attribution: write "Tel Aviv was founded in 1909.[^1]", NEVER "According
  to the Jewish Virtual Library, Tel Aviv was founded in 1909.[^1]" or "The National Library of
  Israel describes...". Constructions like "According to X", "X notes/reports/states/describes/
  records/documents that..." are banned for ordinary facts — the footnote already does that job.
- The ONLY exception is a fact the bundle marks "opinion_only": true (or "source_type":
  "opinion_commentary"): that is commentary, so attribute it in-prose ("X argues that...") so it
  reads as opinion rather than settled fact. Every other fact gets the footnote marker alone,
  and never open consecutive sentences with a named source.

List each source in the references array only once, in the order it is first cited, and
reuse its number for every later footnote to that same source.

## House style — IsraelPedia's editorial stance

IsraelPedia is intentionally written from a pro-Israel, pro-Jewish point of view. This is a
deliberate editorial choice, not neutrality in the traditional journalistic sense. Apply the
following:

- Use "terrorist" / "terrorism" for an act or actor when the bundle's sources characterize it
  that way. Do not soften this to "militant," "fighter," or "activist."
- Refer to the 1948 war primarily as the "War of Independence."
- On the first mention of the territory, write "the West Bank — known by its original,
  indigenous Jewish name of Judea and Samaria" (assert the indigenous origin; this is not a
  neutral "also known as"). After that first mention, use whichever term fits the context:
  "West Bank" reads naturally in contemporary political, geographic, or demographic passages;
  "Judea and Samaria" fits historical, biblical, or Jewish-continuity passages. Do not
  mechanically repeat the full first-mention phrase every time.
- Where the bundle contains material on Jewish historical continuity or indigeneity to the
  land, include it rather than trimming it for brevity.
- Where topically relevant, surface Israeli achievements documented in the bundle (science,
  technology, medicine, humanitarian response).
- You are not required to manufacture an "opposing view" for balance on every contested point
  the way traditional neutral journalism would. Present the bundle's facts accurately without
  artificially offsetting them.
- Only genuinely notable disputes belong in a Controversies or debate section — mainstream
  disagreements, significant public controversies, or real scholarly debates. Do NOT build a
  controversy out of a trivial or minor discrepancy (e.g. a small genealogical or textual
  detail, like whether a figure had six or seven siblings); omit those entirely.
- When a Controversies or debate section is warranted (only where the bundle has
  controversy-flagged facts that clear that notability bar), keep it brief and clearly
  secondary: a short passage noting
  that certain claims rest on tradition or interpretation rather than independent
  verification, without re-litigating each contested point at length. A controversy section
  must never be the longest section of the article, and its hedging language must stay inside
  it — do not let "contested," "not independently verifiable," or similar qualifiers bleed
  into the Legacy, Significance, History, or other sections, which should present the bundle's
  material on its own terms.
- This never licenses inaccuracy. Every claim must still trace to the bundle — the point of
  view lives in framing, word choice, and emphasis, never in stating something the bundle
  does not support.

## Output format

Return ONLY a single JSON object, no prose before or after it:

{
  "title": string (max 75 chars),
  "category": "person" | "place" | "event" | "concept",
  "summary": string (250-1,200 chars, see length rules above),
  "sections": [
    { "heading": string (3-75 chars), "level": 2, "anchor_id": string,
      "content": string (paragraphs split at ~1,000 chars each) }
  ],
  "references": [
    { "source_name": string (3-100 chars), "source_url": string, "accessed_date": "YYYY-MM-DD" }
  ],
  "status": "complete" | "stub",
  "word_count": number (approximate total words across the summary and all section content)
}

## Input you will receive

A research_bundle JSON object (see the Research Agent's output format for its exact shape).`;

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

function clamp75(text: string, what: string): string {
  if (text.length <= 75) return text;
  console.warn(`[Writing] ${what} exceeded 75 chars — truncated: "${text}"`);
  return text.slice(0, 75).trimEnd();
}

// Minor words kept lowercase in Title Case, except as the first or last word.
const TITLE_MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of",
  "on", "or", "per", "the", "to", "via", "vs", "with",
]);

/** Capitalize one word, preserving acronyms / deliberate internal caps (UNESCO, iPhone). */
function capitalizeWord(word: string): string {
  if (/[A-Z]/.test(word.slice(1))) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Title-case a section heading deterministically (recommendation: every word's
 * first letter capitalized, e.g. "liberation, displacement, and survivors" ->
 * "Liberation, Displacement, and Survivors"). Minor words stay lowercase unless
 * they are the first or last word; hyphenated compounds are cased per segment;
 * existing acronyms are left intact. Enforced in code so the output is correct
 * regardless of what the model returns. Shared with the QA Agent.
 */
export function toTitleCase(heading: string): string {
  const words = heading.trim().split(/\s+/);
  return words
    .map((word, i) => {
      const isEdge = i === 0 || i === words.length - 1;
      return word
        .split("-")
        .map((seg, j) => {
          if (!seg) return seg;
          if (!isEdge && j === 0 && TITLE_MINOR_WORDS.has(seg.toLowerCase())) {
            return seg.toLowerCase();
          }
          return capitalizeWord(seg);
        })
        .join("-");
    })
    .join(" ");
}

// Reporting verbs that signal in-prose source attribution ("X notes/reports that...").
const ATTRIBUTION_VERBS =
  "notes|noted|reports|reported|states|stated|describes|described|records|recorded|" +
  "documents|documented|writes|wrote|explains|explained|says|said|observes|observed|" +
  "argues|argued|claims|claimed|suggests|maintains|asserts|confirms|confirmed";

/**
 * Count in-prose source-naming ("According to X", "The [Source] notes that...")
 * across the lead and section bodies. Ordinary facts should carry the footnote
 * alone (see the citation rules); naming the source in the sentence is only for
 * opinion/commentary. This is a heuristic detector used to WARN — the fix is the
 * model obeying the hard rule; the warning makes any relapse visible in the logs.
 */
function countInProseAttribution(
  summary: string,
  sections: { content: string }[]
): number {
  const text = [summary, ...sections.map((s) => s.content)].join(" ");
  const accordingTo = text.match(/\baccording to\b/gi)?.length ?? 0;
  const namedVerb =
    text.match(
      new RegExp(
        `\\b[A-Z][A-Za-z.'&-]+(?:\\s+[A-Z][A-Za-z.'&-]+){0,5}\\s+(?:${ATTRIBUTION_VERBS})\\s+that\\b`,
        "g"
      )
    )?.length ?? 0;
  return accordingTo + namedVerb;
}

/**
 * Approximate word count across the lead and all section bodies. Computed from
 * the actual prose (footnote markers ride along on their word), so it's the
 * authoritative value regardless of what the model claims — checkable by QA and
 * by pipeline metrics. Shared with the QA Agent for its edited_article.
 */
export function countArticleWords(
  summary: string,
  sections: { content: string }[]
): number {
  const text = [summary, ...sections.map((s) => s.content)].join(" ");
  return text.match(/\S+/g)?.length ?? 0;
}

/** Count inline [^n] footnote markers across the lead and all section bodies. */
function countFootnoteMarkers(summary: string, sections: { content: string }[]): number {
  const text = [summary, ...sections.map((s) => s.content)].join(" ");
  return text.match(/\[\^\d+\]/g)?.length ?? 0;
}

/**
 * Minimum target word count for an article (Round-2 recommendation 2.4 +
 * the editorial rule that rich/major topics must run long):
 *   - major topic            → ≥ 3,000 words (no fixed upper limit)
 *   - standard but rich       → ≥ 2,500 words
 *   - thin / minor            → no floor; scale to the material, stub if thin
 * "Rich" = the bundle carries a lot of facts to genuinely support depth
 * (threshold is heuristic — tune against real runs).
 */
function lengthFloorWords(bundle: ResearchBundle): number | null {
  const richEnough = bundle.facts.length > 45;
  if (bundle.significance_tier === "major") return 3000;
  if (richEnough) return 2500;
  return null;
}

/**
 * A per-article length directive appended to the user message (NOT the cached
 * system prompt), computed from the bundle's significance tier and richness.
 * This is the data-driven half of the length fix — the model gets a concrete,
 * bundle-specific floor rather than only the general guidance in the system
 * prompt.
 */
function buildLengthDirective(bundle: ResearchBundle): string {
  const stats = `significance_tier=${bundle.significance_tier}, ${bundle.facts.length} facts, ${bundle.sources.length} sources`;
  if (bundle.significance_tier === "major") {
    return (
      `LENGTH TARGET (${stats}): This is a MAJOR topic. Write a comprehensive, in-depth ` +
      `article of AT LEAST 3,000 words — more if the bundle supports it, with no fixed upper ` +
      `limit. Cover every applicable section deeply and use essentially every substantive fact ` +
      `in the bundle; do not stop early or leave usable material unused.`
    );
  }
  if (lengthFloorWords(bundle)) {
    return (
      `LENGTH TARGET (${stats}): The bundle is rich. Write a substantial article of AT LEAST ` +
      `2,500 words that reflects essentially every substantive fact in the bundle — do not ` +
      `leave usable material unused.`
    );
  }
  return (
    `LENGTH TARGET (${stats}): Scale the length to the available material. A concise, focused ` +
    `article is correct here — do not pad to hit a number. If the bundle is thin, keep it short ` +
    `and set status to "stub".`
  );
}

function normalizeArticle(raw: string, bundle: ResearchBundle): WrittenArticle {
  const parsed = parseLenientJson(extractJson(raw), "Writing Agent article") as Record<
    string,
    unknown
  >;

  const title = clamp75(
    typeof parsed.title === "string" && parsed.title.trim()
      ? parsed.title.trim()
      : bundle.topic,
    "title"
  );

  const sections: ArticleSection[] = [];
  if (Array.isArray(parsed.sections)) {
    for (const s of parsed.sections as Record<string, unknown>[]) {
      const heading = typeof s?.heading === "string" ? s.heading.trim() : "";
      const content = typeof s?.content === "string" ? s.content.trim() : "";
      if (!heading || !content) continue;
      const clamped = clamp75(toTitleCase(heading), "section heading");
      sections.push({
        heading: clamped,
        level: 2,
        anchor_id:
          typeof s?.anchor_id === "string" && s.anchor_id.trim()
            ? kebab(s.anchor_id)
            : kebab(clamped),
        content,
      });
    }
  }
  if (sections.length === 0) {
    throw new Error("Writing Agent returned an article with no usable sections");
  }

  const references: ArticleReference[] = [];
  if (Array.isArray(parsed.references)) {
    for (const r of parsed.references as Record<string, unknown>[]) {
      const url = typeof r?.source_url === "string" ? r.source_url.trim() : "";
      if (!url) continue;
      let sourceName =
        typeof r?.source_name === "string" && r.source_name.trim()
          ? r.source_name.trim()
          : url;
      if (sourceName.length > 100) {
        console.warn(`[Writing] source_name exceeded 100 chars — truncated: "${sourceName}"`);
        sourceName = sourceName.slice(0, 100).trimEnd();
      }
      references.push({
        source_name: sourceName,
        source_url: url,
        accessed_date:
          typeof r?.accessed_date === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(r.accessed_date)
            ? r.accessed_date
            : new Date().toISOString().slice(0, 10),
      });
    }
  }

  // Traceability check: every reference URL should come from the bundle.
  // Warn (don't drop) — removing an entry would shift the [^n] numbering
  // already embedded in the section content.
  const bundleUrls = new Set<string>([
    ...bundle.facts.map((f) => f.source_url.toLowerCase()),
    ...bundle.distinctive_material.map((d) => d.source_url.toLowerCase()),
    ...bundle.sources.map((s) => s.url.toLowerCase()),
  ]);
  for (const ref of references) {
    if (!bundleUrls.has(ref.source_url.toLowerCase())) {
      console.warn(
        `[Writing] Reference not traceable to the bundle (flag for review): ${ref.source_url}`
      );
    }
  }

  // "See also" is intentionally not generated for now (editorial decision) —
  // always emit an empty array regardless of what the model returned.
  const seeAlso: string[] = [];

  // Thin bundle → stub, regardless of what the model claimed.
  const status: ArticleStatus =
    bundle.status === "thin" || parsed.status === "stub" ? "stub" : "complete";

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "";
  // Spec: lead is 250–900 chars, extendable to 1,500 across max 2 paragraphs.
  // Warn only — length is a style rule, not grounds for rejecting the article.
  if (summary && (summary.length < 250 || summary.length > 2200)) {
    console.warn(
      `[Writing] Lead is ${summary.length} chars — outside the spec range of 250–2,200 (flag for review)`
    );
  }

  // Citation-visibility check (Round-2 recommendation 2.1): the model sometimes
  // builds the references[] array but omits the inline [^n] markers entirely
  // (e.g. the King David run had 35 references and zero markers), leaving the
  // article with no visible citations. Flag it loudly so a human/QA can fix —
  // this is a formatting defect, not a rejection.
  const footnoteMarkers = countFootnoteMarkers(summary, sections);
  if (references.length > 0 && footnoteMarkers === 0) {
    console.warn(
      `[Writing] Article has ${references.length} references but NO inline [^n] footnote ` +
        `markers — citations are invisible in the prose (formatting defect, flag for review)`
    );
  } else if (references.length >= 4 && footnoteMarkers < references.length / 2) {
    console.warn(
      `[Writing] Article has ${references.length} references but only ${footnoteMarkers} ` +
        `inline [^n] markers — citations look sparse (flag for review)`
    );
  }

  // In-prose source-naming check (editorial rule: ordinary facts carry the
  // footnote alone; naming the source in the sentence is only for opinion). The
  // hard rule lives in the system prompt; this warns loudly on any relapse.
  const inProseAttributions = countInProseAttribution(summary, sections);
  if (inProseAttributions > 0) {
    console.warn(
      `[Writing] Article names sources in-prose ${inProseAttributions} time(s) ` +
        `("According to X" / "X notes that…") — ordinary facts should use the footnote ` +
        `marker alone, not a named-source phrase (flag for review)`
    );
  }

  // Length check (Round-2 recommendation 2.4): warn when a major/rich topic
  // comes in well under its target so undershooting is visible in the logs.
  const wordCount = countArticleWords(summary, sections);
  const floor = lengthFloorWords(bundle);
  if (floor && wordCount < Math.round(floor * 0.85)) {
    console.warn(
      `[Writing] Article is ~${wordCount} words but significance_tier=${bundle.significance_tier} ` +
        `/ bundle richness targets ≥${floor} — likely too short (flag for review)`
    );
  }

  return {
    title,
    category: bundle.category,
    summary,
    sections,
    see_also: seeAlso,
    references,
    status,
    word_count: wordCount,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Write an article from a research_bundle. The caller must not invoke this
 * for bundles with status "needs_human_research" — this guard is a backstop,
 * the real rejection belongs upstream.
 */
export async function runWriting(bundle: ResearchBundle): Promise<WrittenArticle> {
  if (bundle.status === "needs_human_research") {
    throw new Error(
      `Bundle for "${bundle.topic}" has status "needs_human_research" — the Writing Agent must not be called for it.`
    );
  }

  console.log(
    `[Writing] "${bundle.topic}" (${bundle.category}, bundle status: ${bundle.status}) — ${bundle.facts.length} facts available`
  );

  // Data-driven per-article length floor, appended AFTER the bundle so it never
  // changes the cached system prefix.
  const userContent = `${JSON.stringify(bundle)}\n\n${buildLengthDirective(bundle)}`;

  // One model call + parse. The lenient parser first repairs the malformed JSON
  // models occasionally emit (truncation, trailing commas, control characters, a
  // stray quote); `correction` is appended to the user message only on the retry.
  // Returns the parsed article, or throws a SyntaxError if even repair failed.
  // Set when the model ran out of output budget — the JSON is then truncated,
  // which is a BUDGET problem and must not be mistaken for a formatting one.
  let hitTokenCap = false;

  const generate = async (correction = ""): Promise<WrittenArticle> => {
    const message = await withRetry(
      () =>
        client.messages.create({
          model: WRITING_MODEL,
          max_tokens: MAX_TOKENS,
          // The style guide + templates are identical for every article — cache them.
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userContent + correction }],
        }),
      { label: `${WRITING_MODEL} writing call` }
    );

    // Ran out of output budget: whatever came back is cut off mid-JSON. Say so
    // explicitly — otherwise this surfaces as "malformed JSON" and sends you
    // hunting for a stray quote that isn't there.
    hitTokenCap = message.stop_reason === "max_tokens";
    if (hitTokenCap) {
      console.warn(
        `[Writing] Response hit the ${MAX_TOKENS.toLocaleString()}-token output cap for ` +
          `"${bundle.topic}" (${bundle.facts.length} facts) — the article is TRUNCATED. ` +
          `This is an output-budget problem, not a formatting one.`
      );
    }

    const text = (message.content[0] as { text?: string })?.text;
    if (!text) throw new Error("Writing Agent response contained no text content");
    return normalizeArticle(text, bundle);
  };

  // jsonrepair recovers most malformations for free. The quote-heavy case it
  // can't safely repair throws, and a single clean regeneration — told
  // explicitly to escape its quotes — is the correct fix (a fresh sample rather
  // than a risky guess at the broken one). Only a JSON parse failure is retried;
  // any other error (e.g. an empty article) propagates immediately.
  let article: WrittenArticle;
  try {
    article = await generate();
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Truncated output can't be fixed by regenerating — a fresh sample runs out
    // of budget in the same place, costing another full article's worth of
    // tokens and several minutes to fail identically. Stop and say what to do.
    if (hitTokenCap) {
      throw new Error(
        `Writing Agent ran out of output budget for "${bundle.topic}" (${bundle.facts.length} facts, ` +
          `tier=${bundle.significance_tier}): the response hit the ${MAX_TOKENS.toLocaleString()}-token ` +
          `cap and the truncated JSON could not be salvaged. Regenerating would truncate at the same ` +
          `point, so it was not attempted. Raise MAX_TOKENS in agents/writing.ts (the SDK's hard ` +
          `non-streaming ceiling is ${NON_STREAMING_MAX_TOKENS.toLocaleString()}), or switch this ` +
          `agent to client.messages.stream(...).finalMessage() to go beyond it.`
      );
    }
    console.warn(
      `[Writing] Article JSON could not be parsed even after repair (${err.message}) — regenerating once`
    );
    article = await generate(
      "\n\nIMPORTANT: your previous response was not valid JSON. Return ONLY a single valid " +
        'JSON object, and escape every double-quote that appears inside a string value as \\".'
    );
  }

  console.log(
    `[Writing] "${article.title}" — ${article.sections.length} sections, ` +
      `${article.references.length} references, status=${article.status}`
  );
  return article;
}
