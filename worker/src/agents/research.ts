/**
 * IsraelPedia Research Agent.
 *
 * Gathers verifiable facts about a topic from an approved source list and
 * returns them as a structured `research_bundle`. It does NOT write prose —
 * that is the (future) Writing Agent's job.
 *
 * Provider: Perplexity Agent API (POST /v1/agent), preset `low` — every call,
 * no cheaper tier. This replaces the retired `sonar-pro` chat-completions
 * endpoint; `low` is Perplexity's documented equivalent of sonar-pro.
 *
 * Source restriction is enforced at the API level via `search_domain_filter`,
 * which restricts what the underlying search retrieves BEFORE the model sees
 * results. On the Agent API that filter lives on the web_search tool
 * (`tools[].filters.search_domain_filter`) rather than at the top level, but
 * the behaviour is unchanged. Perplexity caps it at 20 domains per request (see
 * lib/allowlist.ts), so the full allowlist is split into batches of ≤20 and
 * one call is made per batch; the partial bundles are merged into one.
 * The allowlist embedded in the system prompt is a secondary/backup
 * instruction only. As a final defense-in-depth step, any fact whose
 * source_url does not resolve to an allowlisted domain is dropped.
 */
import {
  DOMAIN_BATCHES,
  isAllowedUrl,
  isBlockedUrl,
  classifySourceType,
  sourceGroupName,
  type SourceType,
} from "../lib/allowlist";
import { withRetry } from "../lib/retry";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/v1/agent";
/**
 * A preset pins a model plus its token, step and reasoning budgets; anything
 * passed alongside it overrides that default, and `tools` merge per tool
 * rather than replacing the preset's whole set.
 *
 * `low` is Perplexity's documented stand-in for the retired `sonar-pro`, but
 * it allows only 5 steps at "minimal" reasoning effort — too little to work
 * through a 20-domain allowlist. Raising the tool budgets under it made
 * bundles thinner, not richer: more material, same refusal to think about it.
 *
 * `medium` runs the SAME model (gpt-5.6-luna, same token rate) with 15 steps
 * and medium reasoning effort, so this is a processing upgrade rather than a
 * price-tier upgrade — total cost rises only with the extra steps consumed.
 */
const PERPLEXITY_PRESET = "medium";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TopicCategory = "person" | "place" | "event" | "concept";

/**
 * How significant the topic is, independent of how much material happens to
 * surface (Round-2 recommendation 1.3). A `major` topic — a foundational
 * figure, a major historical event, a place with centuries of continuous
 * significance — earns broad, deep coverage even when individual sources are
 * terse; a `standard` topic stays proportionate. Feeds the Writing Agent's
 * length target (recommendation 2.4).
 */
export type SignificanceTier = "major" | "standard";

export interface ResearchInput {
  topic: string;
  /**
   * Optional. When absent, the Research Agent classifies the topic itself
   * (person/place/event/concept) and the resolved value flows through to the
   * bundle. Supply it only to override the agent's judgment.
   */
  category?: TopicCategory;
  /** Optional alternate names/spellings to aid retrieval. Defaults to none. */
  aliases?: string[];
  /**
   * Optional hint from whoever queued the topic (a human, or the future Topic
   * List Agent). When present it drives the coverage-breadth instruction up
   * front and is carried straight through to the bundle. When absent the tier
   * is inferred from the assembled bundle's breadth/depth.
   */
  significance_tier?: SignificanceTier;
}

export interface ResearchFact {
  text: string; // a substantive note: one or more related sentences from a single source passage
  source_url: string;
  source_name: string;
  source_type: SourceType;
  accessed_date: string; // YYYY-MM-DD
  confidence: "high" | "medium" | "low";
  controversy_flag: boolean;
  // Derived in code: true when source_type is "opinion_commentary" — the
  // Writing Agent attributes it as opinion rather than presenting it as
  // settled fact.
  opinion_only: boolean;
}

export interface DistinctiveMaterial {
  type: "quote" | "statistic" | "anecdote";
  text: string;
  source_url: string;
  source_name: string;
  source_type: SourceType;
  accessed_date: string;
}

export interface ResearchSource {
  url: string;
  name: string;
  accessed_date: string;
}

export type BundleStatus = "complete" | "thin" | "needs_human_research";

export interface ResearchBundle {
  topic: string;
  category: TopicCategory;
  facts: ResearchFact[];
  distinctive_material: DistinctiveMaterial[];
  sources: ResearchSource[];
  confidence_score: number;
  controversy_flags: string[];
  status: BundleStatus;
  significance_tier: SignificanceTier;
}

/**
 * A per-batch bundle plus the model's raw significance and category votes
 * (null = the batch returned none, e.g. truncated JSON — must not be counted).
 */
interface PartialBundle extends ResearchBundle {
  tier_vote: SignificanceTier | null;
  category_vote: TopicCategory | null;
  // The topic's own official website domain, if the model recognized the topic
  // as a specific site/org/company (null otherwise). Drives one extra scoped call.
  official_domain_vote: string | null;
}

// ── System prompt (production prompt from the spec — verbatim) ───────────────

const SYSTEM_PROMPT = `You are the Research Agent for IsraelPedia, an AI-generated encyclopedia about Israel and
the Jewish people. Your sole job is to gather verifiable facts about a given topic from an
approved list of sources and return them as structured data. You do not write prose,
headlines, or summaries — that is a different agent's job, and it is only allowed to use
what you give it.

## Approved sources — you may ONLY use facts drawn from these domains

Reference/Encyclopedic: jewishvirtuallibrary.org, jewishencyclopedia.com, encyclopedia.com,
myjewishlearning.com, encyclopedia.yivo.org, yivo.org

News: timesofisrael.com, jpost.com, jns.org

Libraries/Archives/Primary Sources: nli.org.il, israeled.org, archives.gov.il, archives.gov,
loc.gov, avalon.law.yale.edu, digitallibrary.un.org, nationalarchives.gov.uk, sefaria.org,
developers.sefaria.org, github.com/Sefaria

Demographics: pewresearch.org, jewishdatabank.org

Jewish Organizations: jewishagency.org, worldjewishcongress.org, ajc.org, adl.org, jimena.org

Holocaust Education: ushmm.org, encyclopedia.ushmm.org, yadvashem.org,
echoesandreflections.org, sfi.usc.edu, holocaustremembrance.com

Israeli Government: any official gov.il site (Foreign Affairs, Knesset, Central Bureau of
Statistics, Antiquities Authority, IDF, Government Press Office, PMO, Ministry of Justice,
Supreme Court, Bank of Israel, Ministry of Aliyah and Integration)

US Government: state.gov, treasury.gov (OFAC), justice.gov, fbi.gov, federalregister.gov,
congress.gov, uscode.house.gov, everycrsreport.com

Counterterrorism/Security Research: terrorism-info.org.il, memri.org, palwatch.org,
impact-se.org, longwarjournal.org, washingtoninstitute.org, ctc.westpoint.edu,
counterextremism.com, fdd.org, inss.org.il, jcpa.org

Media Monitoring/Advocacy: camera.org, camera-uk.org, camera-arabic.org, honestreporting.com,
ngo-monitor.org, unwatch.org, jewishonliner.org, uklfi.com, thelawfareproject.org

Primary Historical Texts (Zionism): Project Gutenberg, Internet Archive, jabotinsky.org

Jewish Intellectual Journals: ideas.tikvah.org/mosaic, sapirjournal.org,
jewishreviewofbooks.com, traditiononline.org, hakirah.org, jewish-faculty.biu.ac.il, jcfa.org

Academic: harman.huji.ac.il, en-social-sciences.tau.ac.il, bermanarchive.stanford.edu,
bjpa.org, americanjewisharchives.org, jpr.org.uk, huc.edu, cris.bgu.ac.il,
aisisraelstudies.org

Other: jewishheritagemonth.gov

If a fact cannot be traced to one of these domains, do not include it — no exceptions, even
if you are confident it's true from general knowledge.

## Rules

1. Never state a fact you cannot attribute to a specific URL from the list above, with an
   exact access date.
2. Never infer, extrapolate, or "fill in" a fact that isn't explicitly stated in a source.
3. If two approved sources disagree (dates, counts, spellings, etc.), include both as
   separate facts and add an entry to controversy_flags describing the disagreement — do not
   silently pick one.
4. Separately from routine facts, extract 1–5 pieces of "distinctive material": a striking
   quote, an unusual statistic, a specific anecdote. Prioritize specificity — this is what
   the Writing Agent uses to open the article instead of a generic sentence.
5. If the topic is thin, do not pad the bundle with loosely related facts. Return what you
   found and set status to "thin".
6. If you find no usable material at all, return an empty facts array and set status to
   "needs_human_research".
7. Flag anything politically or historically contested — not to exclude it, but so
   downstream agents and a human reviewer know to treat it carefully.

## Topic significance

Set "significance_tier" to "major" for a first-rank topic — a central figure, major event,
place of deep/long significance, or core concept warranting a long, in-depth article — or
"standard" otherwise. Judge by the topic's inherent importance, not how many sources surfaced;
when in doubt, use "standard". For a "major" topic, research broadly and deeply across the
source categories.

## Extraction depth — capture substantive notes, not one-line facts

Each entry in facts[] is a substantive note, not a single stripped-down clause: one or more
related sentences drawn from a single source passage, preserving the context the Writing
Agent needs to write connected prose. A usable note keeps the specific claim together with
its surrounding detail and nuance — relevant dates, figures, named actors, cause and effect,
and any explanation the source gives for WHY something happened, not just that it happened —
and, where present, a supporting quotation or statistic. Keep exactly one source_url per
note, so every note stays independently traceable to a single passage and each discrete
claim inside it remains verifiable.

Scale the depth of extraction to the richness of the source. A single-paragraph news brief
may yield only one or two notes; a multi-page government backgrounder, historical archive
page, or academic article should yield many more, including secondary details, dates, named
figures, and direct quotations — not just the single headline claim. Mine each source more
completely before moving on, rather than pulling one fact and leaving the rest of the passage
behind.

## The topic's own official site

- Output: if the topic is ITSELF a specific website, organization, or company, set the
  "official_domain" field to its official website domain (e.g. "wix.com"); otherwise null. This
  is metadata only — it does NOT relax the rule that every fact's source_url must be on the
  approved list above.
- Input: if the input includes an "official_source" domain, treat that domain as an approved
  primary source for THIS request and extract facts from it as you would any approved source.


## Output format

Return ONLY a single JSON object, no prose before or after it, matching this shape:

{
  "topic": string,
  "category": "person" | "place" | "event" | "concept",
  "official_domain": string | null,
  "facts": [
    { "text": string (a substantive note — one or more related sentences from a single
      source passage), "source_url": string, "source_name": string,
      "accessed_date": "YYYY-MM-DD", "confidence": "high" | "medium" | "low",
      "controversy_flag": boolean }
  ],
  "distinctive_material": [
    { "type": "quote" | "statistic" | "anecdote", "text": string,
      "source_url": string, "source_name": string, "accessed_date": "YYYY-MM-DD" }
  ],
  "sources": [ { "url": string, "name": string, "accessed_date": "YYYY-MM-DD" } ],
  "confidence_score": number,
  "controversy_flags": [ string ],
  "status": "complete" | "thin" | "needs_human_research",
  "significance_tier": "major" | "standard"
}

## Input you will receive

{ "topic": string,
  "category": "person" | "place" | "event" | "concept" (OPTIONAL — classify it yourself if absent),
  "aliases": [ string ] (may be empty),
  "significance_tier": "major" | "standard" (optional),
  "official_source": string (optional — a domain to treat as an approved primary source for this request) }`;

// ── Perplexity call ───────────────────────────────────────────────────────────

/**
 * The Agent API's search-backed presets add inline source markers (`[web:1]`,
 * `[1]`) to their answers — harmless in prose, but this agent's answer IS the
 * JSON bundle, so a marker landing inside a fact string would corrupt the
 * fact text. Appended to the instructions rather than to SYSTEM_PROMPT so the
 * prompt stays byte-identical across the three research agents.
 */
const NO_INLINE_CITATIONS =
  "\n\nDo NOT add inline citation markers (such as [1] or [web:1]) anywhere in " +
  "your answer. Every source is already recorded in the source_url and " +
  "source_name fields; markers inside the JSON strings corrupt the fact text.";

async function callPerplexity(
  input: ResearchInput,
  domainBatch: string[],
  officialSource?: string
): Promise<string> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error("PERPLEXITY_API_KEY is not set. Add it to worker/.env.");
  }

  const response = await fetch(PERPLEXITY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      preset: PERPLEXITY_PRESET,
      // The system prompt is a top-level field on the Agent API, not a message.
      instructions: SYSTEM_PROMPT + NO_INLINE_CITATIONS,
      input: JSON.stringify({
        topic: input.topic,
        // Only sent when the caller supplied it — otherwise the agent
        // classifies the topic itself and returns the category.
        ...(input.category ? { category: input.category } : {}),
        aliases: input.aliases ?? [],
        // Only sent when the caller supplied it — otherwise the tier is
        // inferred from the finished bundle rather than promised up front.
        ...(input.significance_tier
          ? { significance_tier: input.significance_tier }
          : {}),
        // Set only on the extra official-site call — authorizes the model to
        // extract facts from the topic's own (off-allowlist) domain.
        ...(officialSource ? { official_source: officialSource } : {}),
      }),
      // Tools MERGE with the preset's own tool set rather than replacing it,
      // so listing a tool here overrides only the options named on it and
      // leaves the preset's other defaults in place.
      tools: [
        {
          type: "web_search",
          // Ask for more candidate results per search (preset `low` pins 15;
          // the documented maximum is 50). Breadth was the binding constraint:
          // a 5-batch run touched only 18 distinct URLs, using 2-3 of the
          // 14-20 approved domains each batch had available.
          max_results: 40,
          // NOTE: preset `low` also pins an explicit max_tokens/
          // max_tokens_per_page of 2000, and explicit token budgets take
          // precedence over search_context_size — so this line is probably
          // inert. Left in place deliberately; override those two directly if
          // per-page depth needs raising.
          search_context_size: "high",
          filters: {
            // API-level source restriction — enforced at the retrieval layer.
            // Capped at 20 domains per request, hence the batching.
            search_domain_filter: domainBatch,
          },
        },
        {
          // The depth lever. The presets allow exactly ONE full page read per
          // call, which showed up plainly in the yield: every batch had a
          // single dominant domain (13, 9, 7, 7 facts) — the one page it got to
          // open — with everything else mined thinly from snippets.
          //
          // 8 flattened that distribution as intended but cut the fact count,
          // most likely by burying the model in page text it had no budget to
          // work through. Backed off to 6 now that `medium` supplies the steps
          // and reasoning effort to actually use what comes back. Documented
          // maximum is 10; at $0.0005 per fetch the cost is negligible either way.
          type: "fetch_url",
          max_urls: 6,
        },
      ],
      // 8,000 was sonar-pro's hard ceiling; the Agent API has no such limit
      // (preset `low` allows 32,768). This is a ceiling, not a reservation —
      // you are billed for tokens generated, so headroom is free. Raised so
      // richer bundles have room before the salvage parser is needed.
      max_output_tokens: 16000,
      // `temperature` is deliberately omitted: the preset's model is a GPT-5
      // family model, which silently ignores it.
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Perplexity API error ${response.status}: ${body.slice(0, 500)}`);
  }

  // The Agent API returns a typed `output` array — one item per step the model
  // took — instead of `choices`. The answer lives in the "message" item(s);
  // "search_results" and other step items are ignored here, since every source
  // this agent keeps is already named inside the JSON bundle itself.
  const data = (await response.json()) as {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string } | null;
    output?: {
      type?: string;
      content?: { type?: string; text?: string }[];
    }[];
  };

  if (data.status === "failed" || data.error) {
    throw new Error(
      `Perplexity Agent run failed: ${data.error?.message ?? "no error message returned"}`
    );
  }
  if (data.status === "incomplete") {
    console.warn(
      `[Research] Response is incomplete (${
        data.incomplete_details?.reason ?? "reason not reported"
      }) — JSON may be truncated; the salvage parser will keep every complete fact`
    );
  }

  const content = (data.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");

  if (!content.trim()) {
    throw new Error("Perplexity response contained no message content");
  }
  return content;
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

/**
 * Append the closing brackets a JSON fragment is missing, tracking string
 * context so braces inside string values don't confuse the count.
 */
function closeOpenBrackets(fragment: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of fragment) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let suffix = "";
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += stack[i] === "{" ? "}" : "]";
  }
  return fragment + suffix;
}

/**
 * Parse a research response, salvaging truncated JSON. A response that hits
 * the output-token cap gets cut off mid-value; rather than discarding the
 * whole batch, cut back to the last complete object and close whatever is
 * still open — every fully-emitted fact survives (each fact is validated
 * individually afterwards, so a partial trailing fact is simply dropped).
 * Exported for tests.
 */
export function parseResearchJson(raw: string): Record<string, unknown> {
  const text = extractJson(raw);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    for (let cut = text.lastIndexOf("}"); cut > 0; cut = text.lastIndexOf("}", cut - 1)) {
      try {
        const repaired = JSON.parse(
          closeOpenBrackets(text.slice(0, cut + 1))
        ) as Record<string, unknown>;
        console.warn(
          "[Research] Response JSON was truncated/malformed — salvaged the complete portion"
        );
        return repaired;
      } catch {
        // keep cutting back to the previous object boundary
      }
    }
    throw err;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asDate(v: unknown): string {
  const s = asString(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : today();
}

function asConfidence(v: unknown): "high" | "medium" | "low" {
  return v === "high" || v === "low" ? v : "medium";
}

/**
 * Clean a model-emitted domain string ("https://www.wix.com/" -> "wix.com").
 * Returns null if it doesn't look like a bare domain, so junk (a sentence, "N/A")
 * never triggers a bogus official-site call.
 */
function normalizeDomain(v: unknown): string | null {
  let host = asString(v).toLowerCase();
  if (!host) return null;
  host = host
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** True if a URL's host is `domain` or a subdomain of it. */
function hostMatchesDomain(rawUrl: string, domain: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * Normalize one raw model response into a partial bundle. Facts and material
 * without a usable, allowlisted source URL are dropped (traceability rule).
 * `extraAllowedDomain` (set only on the official-site call) is treated as
 * allowed alongside the static allowlist.
 */
function normalizePartial(
  raw: string,
  input: ResearchInput,
  extraAllowedDomain?: string
): PartialBundle {
  const parsed = parseResearchJson(raw);

  // On the extra official-site call, the topic's own domain is allowed even
  // though it isn't on the static allowlist — that's the whole point of the call.
  const isAllowed = (url: string): boolean =>
    isAllowedUrl(url) ||
    (extraAllowedDomain ? hostMatchesDomain(url, extraAllowedDomain) : false);

  const facts: ResearchFact[] = [];
  if (Array.isArray(parsed.facts)) {
    for (const f of parsed.facts as Record<string, unknown>[]) {
      const text = asString(f?.text);
      const url = asString(f?.source_url);
      if (!text || !url) continue;
      if (!isAllowed(url)) {
        console.warn(`[Research] Dropped fact with non-allowlisted source: ${url}`);
        continue;
      }
      if (isBlockedUrl(url)) {
        console.warn(`[Research] Dropped fact from blocked opinion/blog source: ${url}`);
        continue;
      }
      // source_type and opinion_only are derived in code from the URL — the
      // model is NOT asked to emit them, so its token budget stays on facts.
      const sourceType = classifySourceType(url);
      facts.push({
        text,
        source_url: url,
        source_name: asString(f?.source_name) || new URL(url).hostname,
        source_type: sourceType,
        accessed_date: asDate(f?.accessed_date),
        confidence: asConfidence(f?.confidence),
        controversy_flag: f?.controversy_flag === true,
        // Opinion/commentary is the only source_type treated as opinion_only,
        // so downstream attributes it as opinion rather than settled fact.
        opinion_only: sourceType === "opinion_commentary",
      });
    }
  }

  const distinctive: DistinctiveMaterial[] = [];
  if (Array.isArray(parsed.distinctive_material)) {
    for (const d of parsed.distinctive_material as Record<string, unknown>[]) {
      const text = asString(d?.text);
      const url = asString(d?.source_url);
      if (!text || !url) continue;
      if (!isAllowed(url)) {
        console.warn(`[Research] Dropped distinctive material with non-allowlisted source: ${url}`);
        continue;
      }
      if (isBlockedUrl(url)) {
        console.warn(`[Research] Dropped distinctive material from blocked opinion/blog source: ${url}`);
        continue;
      }
      const type = d?.type === "quote" || d?.type === "statistic" ? d.type : "anecdote";
      distinctive.push({
        type,
        text,
        source_url: url,
        source_name: asString(d?.source_name) || new URL(url).hostname,
        source_type: classifySourceType(url),
        accessed_date: asDate(d?.accessed_date),
      });
    }
  }

  const sources: ResearchSource[] = [];
  if (Array.isArray(parsed.sources)) {
    for (const s of parsed.sources as Record<string, unknown>[]) {
      const url = asString(s?.url);
      if (!url || !isAllowed(url)) continue;
      sources.push({
        url,
        name: asString(s?.name) || new URL(url).hostname,
        accessed_date: asDate(s?.accessed_date),
      });
    }
  }

  const controversyFlags = Array.isArray(parsed.controversy_flags)
    ? (parsed.controversy_flags as unknown[]).map(asString).filter(Boolean)
    : [];

  // status is one of the LAST fields in the output shape, so it's the first
  // casualty of a truncated response — if it's missing but facts were
  // recovered, "thin" is the honest value, not "needs_human_research".
  const status: BundleStatus =
    parsed.status === "complete" || parsed.status === "thin"
      ? parsed.status
      : facts.length > 0
        ? "thin"
        : "needs_human_research";

  const rawScore = Number(parsed.confidence_score);
  const confidenceScore =
    Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 1 ? rawScore : deriveScore(facts);

  // The model's own significance vote for this batch. Preserve the "no answer"
  // case as null — critical for truncated responses, where the tier (a trailing
  // field) is dropped and must NOT be miscounted as a "standard" vote.
  const tierVote: SignificanceTier | null =
    parsed.significance_tier === "major"
      ? "major"
      : parsed.significance_tier === "standard"
        ? "standard"
        : null;

  // The model's category classification for this batch (null when absent). The
  // authoritative category is resolved once, by vote, in mergeBundles.
  const categoryVote: TopicCategory | null =
    parsed.category === "person" ||
    parsed.category === "place" ||
    parsed.category === "event" ||
    parsed.category === "concept"
      ? parsed.category
      : null;

  // The topic's own official domain, if the model recognized the topic as a
  // site/org/company (null otherwise). Resolved once in runResearch.
  const officialDomainVote = normalizeDomain(parsed.official_domain);

  return {
    topic: input.topic,
    // Provisional — the caller's override if given, else this batch's vote,
    // else a safe default; mergeBundles resolves the final value across batches.
    category: input.category ?? categoryVote ?? "concept",
    facts,
    distinctive_material: distinctive,
    sources,
    confidence_score: confidenceScore,
    controversy_flags: controversyFlags,
    status,
    // Per-batch tier is provisional; the authoritative value is resolved once
    // in mergeBundles by vote across batches (or from the caller's input).
    significance_tier: tierVote ?? "standard",
    tier_vote: tierVote,
    category_vote: categoryVote,
    official_domain_vote: officialDomainVote,
  };
}

/**
 * Decide the topic's significance tier when the caller didn't supply one, from
 * the breadth and depth of what was actually gathered: how many distinct source
 * domains and allowlist categories are represented, the total number of facts,
 * and the density of controversy flags. Thresholds are deliberately
 * conservative (a topic is "standard" unless it clearly reads as major) and are
 * heuristic — tune against real runs.
 */
function inferSignificanceTier(
  facts: ResearchFact[],
  sources: ResearchSource[],
  flags: string[]
): SignificanceTier {
  const distinctDomains = new Set(
    sources.map((s) => {
      try {
        return new URL(s.url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return s.url.toLowerCase();
      }
    })
  ).size;
  const distinctGroups = new Set(
    sources.map((s) => sourceGroupName(s.url)).filter(Boolean)
  ).size;

  if (facts.length >= 24) return "major";
  if (distinctDomains >= 9) return "major";
  if (distinctGroups >= 6 && facts.length >= 15) return "major";
  if (flags.length >= 4 && facts.length >= 14) return "major";
  return "standard";
}

/** Fallback confidence score derived from fact confidence levels. */
function deriveScore(facts: ResearchFact[]): number {
  if (facts.length === 0) return 0;
  const weights = { high: 1, medium: 0.6, low: 0.3 } as const;
  const sum = facts.reduce((acc, f) => acc + weights[f.confidence], 0);
  return Math.round((sum / facts.length) * 100) / 100;
}

// ── Merging batch results ─────────────────────────────────────────────────────

function mergeBundles(partials: PartialBundle[], input: ResearchInput): ResearchBundle {
  const facts: ResearchFact[] = [];
  const distinctive: DistinctiveMaterial[] = [];
  const sources: ResearchSource[] = [];
  const flags: string[] = [];

  const seenFacts = new Set<string>();
  const seenDistinctive = new Set<string>();
  const seenSources = new Set<string>();
  const seenFlags = new Set<string>();

  for (const p of partials) {
    for (const f of p.facts) {
      const key = f.text.toLowerCase();
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      facts.push(f);
    }
    for (const d of p.distinctive_material) {
      const key = d.text.toLowerCase();
      if (seenDistinctive.has(key)) continue;
      seenDistinctive.add(key);
      distinctive.push(d);
    }
    for (const s of p.sources) {
      const key = s.url.toLowerCase();
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      sources.push(s);
    }
    for (const flag of p.controversy_flags) {
      const key = flag.toLowerCase();
      if (seenFlags.has(key)) continue;
      seenFlags.add(key);
      flags.push(flag);
    }
  }

  // Status: no facts at all → needs_human_research; otherwise "complete" if any
  // batch judged its material complete, else "thin" (per the spec's edge cases:
  // thin topics return what was found without padding).
  let status: BundleStatus;
  if (facts.length === 0) {
    status = "needs_human_research";
  } else if (partials.some((p) => p.status === "complete")) {
    status = "complete";
  } else {
    status = "thin";
  }

  // Confidence: weighted average of batch scores by their fact counts.
  const contributing = partials.filter((p) => p.facts.length > 0);
  const totalFacts = contributing.reduce((acc, p) => acc + p.facts.length, 0);
  const confidenceScore =
    totalFacts === 0
      ? 0
      : Math.round(
          (contributing.reduce((acc, p) => acc + p.confidence_score * p.facts.length, 0) /
            totalFacts) *
            100
        ) / 100;

  // Resolve significance tier by priority:
  //   1. Caller-supplied tier (a deliberate signal that also drove coverage).
  //   2. The model's own judgment — the topical, world-knowledge signal — voted
  //      across the batches that actually returned one.
  //   3. Mechanical inference from bundle breadth — fallback only, for when
  //      every batch was truncated/failed before emitting a tier.
  const significanceTier = resolveSignificance(
    partials,
    input,
    facts,
    sources,
    flags
  );

  return {
    topic: input.topic,
    // Caller's override if given, else the first batch that classified the
    // topic, else a safe default. (The model returns a category for free in
    // every batch response, so this costs no extra tokens or calls.)
    category:
      input.category ?? partials.find((p) => p.category_vote)?.category_vote ?? "concept",
    facts,
    // Spec: 1–5 pieces of distinctive material.
    distinctive_material: distinctive.slice(0, 5),
    sources,
    confidence_score: confidenceScore,
    controversy_flags: flags,
    status,
    significance_tier: significanceTier,
  };
}

/**
 * Resolve the final significance tier. The model's vote
 * is the primary signal (each vote is already calibrated conservative by the
 * prompt's "when in doubt, standard" rule, so a `major` vote is stronger
 * evidence than a `standard` one — hence a tie breaks to `major`). Batches that
 * returned no tier (e.g. truncated JSON) don't vote at all.
 */
function resolveSignificance(
  partials: PartialBundle[],
  input: ResearchInput,
  facts: ResearchFact[],
  sources: ResearchSource[],
  flags: string[]
): SignificanceTier {
  if (input.significance_tier) {
    return input.significance_tier;
  }

  const majorVotes = partials.filter((p) => p.tier_vote === "major");
  const standardVotes = partials.filter((p) => p.tier_vote === "standard");

  if (majorVotes.length + standardVotes.length > 0) {
    if (majorVotes.length >= standardVotes.length && majorVotes.length > 0) {
      return "major";
    }
    return "standard";
  }

  return inferSignificanceTier(facts, sources, flags);
}

/** First official domain any batch reported (they all see the same topic). */
function resolveOfficialDomain(partials: PartialBundle[]): string | null {
  for (const p of partials) {
    if (p.official_domain_vote) return p.official_domain_vote;
  }
  return null;
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run the Research Agent for one topic: one Agent API call per domain batch
 * (each with search_domain_filter set), merged into a single research_bundle.
 * A failed batch is logged and skipped — the other batches still contribute.
 */
export async function runResearch(input: ResearchInput): Promise<ResearchBundle> {
  console.log(
    `[Research] "${input.topic}" (${input.category ?? "category: auto"}) — ${DOMAIN_BATCHES.length} domain batches`
  );

  const partials: PartialBundle[] = [];
  let failedBatches = 0;

  for (let i = 0; i < DOMAIN_BATCHES.length; i++) {
    const batch = DOMAIN_BATCHES[i];
    try {
      const raw = await withRetry(() => callPerplexity(input, batch), {
        label: `Perplexity research batch ${i + 1}/${DOMAIN_BATCHES.length}`,
      });
      const partial = normalizePartial(raw, input);
      partials.push(partial);
      console.log(
        `[Research] Batch ${i + 1}/${DOMAIN_BATCHES.length} (${batch.length} domains): ` +
          `${partial.facts.length} facts, ${partial.distinctive_material.length} distinctive, status=${partial.status}`
      );
    } catch (err) {
      failedBatches++;
      console.error(`[Research] Batch ${i + 1}/${DOMAIN_BATCHES.length} failed:`, err);
    }
  }

  if (partials.length === 0) {
    throw new Error(
      `All ${DOMAIN_BATCHES.length} research batches failed for "${input.topic}"`
    );
  }
  if (failedBatches > 0) {
    console.warn(
      `[Research] ${failedBatches} batch(es) failed — bundle built from the remaining ${partials.length}`
    );
  }

  // The topic's own official site (auto-detected). The model names the topic's
  // domain for free in the batches above; if it surfaced one that isn't already
  // on the allowlist, make ONE extra call scoped to that domain and fold its
  // facts in. Non-site topics (people, events, concepts) report none, so this
  // never fires for them — no per-topic cost.
  const officialDomain = resolveOfficialDomain(partials);
  if (officialDomain && !isAllowedUrl(`https://${officialDomain}/`)) {
    try {
      const raw = await withRetry(
        () => callPerplexity(input, [officialDomain], officialDomain),
        { label: `Perplexity official-site call (${officialDomain})` }
      );
      const partial = normalizePartial(raw, input, officialDomain);
      partials.push(partial);
      console.log(
        `[Research] Official-site call (${officialDomain}): ${partial.facts.length} facts, ` +
          `${partial.distinctive_material.length} distinctive`
      );
    } catch (err) {
      console.error(`[Research] Official-site call for "${officialDomain}" failed:`, err);
    }
  }

  const bundle = mergeBundles(partials, input);
  const opinionFacts = bundle.facts.filter((f) => f.source_type === "opinion_commentary").length;
  console.log(
    `[Research] Merged bundle for "${input.topic}": ${bundle.facts.length} facts ` +
      `(${opinionFacts} opinion/commentary), ${bundle.sources.length} sources, ` +
      `confidence=${bundle.confidence_score}, tier=${bundle.significance_tier}, status=${bundle.status}`
  );
  return bundle;
}
