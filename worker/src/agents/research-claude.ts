/**
 * IsraelPedia Research Agent — Claude variant.
 *
 * A drop-in alternative to the Perplexity Research Agent (agents/research.ts).
 * Same job, same system prompt, same input, same `research_bundle` output — the
 * only difference is the provider: Claude Sonnet 5 driving Anthropic's server-side
 * `web_search` + `web_fetch` tools instead of Perplexity's `sonar-pro`.
 *
 * Why it exists: sonar-pro's yield collapsed to a handful of facts from a
 * handful of domains, and every downstream agent is built on this bundle, so a
 * thin bundle caps the quality of the whole article. This agent keeps the
 * contract identical so the Writing and QA agents consume it unchanged, and the
 * two can be run head-to-head on the same topic list.
 *
 * Source restriction is enforced at the API level via each tool's
 * `allowed_domains`, which restricts what search and fetch can reach BEFORE the
 * model sees anything. Unlike Perplexity, Anthropic imposes no 20-domain cap —
 * but the allowlist is still split into the same DOMAIN_BATCHES and one call is
 * made per batch, deliberately: forcing a separate pass over each thematic
 * source group is what produces breadth across the whole allowlist instead of
 * the model settling into whichever two sites answer first. The allowlist
 * embedded in the system prompt is a secondary/backup instruction only, and as a
 * final defense-in-depth step any fact whose source_url does not resolve to an
 * allowlisted domain is dropped.
 *
 * NOTE: the parsing/normalization/merge logic below is a deliberate duplicate of
 * agents/research.ts so the two agents stay independently editable. If you fix a
 * bug in one, fix it in the other.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  DOMAIN_BATCHES,
  isAllowedUrl,
  isBlockedUrl,
  classifySourceType,
  sourceGroupName,
} from "../lib/allowlist";
import { withRetry, isRetryableError } from "../lib/retry";
import type {
  BundleStatus,
  DistinctiveMaterial,
  ResearchBundle,
  ResearchFact,
  ResearchInput,
  ResearchSource,
  SignificanceTier,
  TopicCategory,
} from "./research";

// Re-exported so callers can import the whole contract from either agent.
export type {
  BundleStatus,
  DistinctiveMaterial,
  ResearchBundle,
  ResearchFact,
  ResearchInput,
  ResearchSource,
  SignificanceTier,
  TopicCategory,
};

const CLAUDE_MODEL = "claude-sonnet-5";
/**
 * Server-side refusal fallback re-routes a request the safety classifiers
 * decline — worth having on this subject matter, but only the Opus/Fable tier
 * accepts the parameter (Sonnet 5 rejects it with a 400). Derived from the
 * model so switching CLAUDE_MODEL back to an Opus model re-enables it without
 * another edit.
 */
const SUPPORTS_FALLBACKS = /^claude-(opus|fable|mythos)/.test(CLAUDE_MODEL);
/**
 * Reasoning depth. "high" is the API default and the right balance here; raise
 * to "xhigh" if bundles still come back thin, at a real cost increase.
 */
const EFFORT = "high";
/** Streamed, so this is headroom for adaptive thinking + the bundle JSON. */
const MAX_TOKENS = 24_000;
/** Per-batch tool budgets — the depth lever. Raise for richer bundles, at cost. */
const WEB_SEARCH_MAX_USES = 12;
const WEB_FETCH_MAX_USES = 12;
/**
 * Ceiling on the content ONE web_fetch pulls into context. Without this the
 * full page lands in the conversation, and since every server-tool iteration
 * re-reads the whole accumulated context — and every pause/resume re-sends it —
 * a dozen long pages compound into a context spiral that makes each batch
 * progressively slower and more expensive. ~6k tokens is roughly 24k characters,
 * enough to mine a substantial article. Raise it for more depth per page, at the
 * cost of the spiral coming back.
 */
const WEB_FETCH_MAX_CONTENT_TOKENS = 6_000;
/**
 * A server-tool turn pauses (`stop_reason: "pause_turn"`) every 10 server-side
 * iterations and must be resumed by handing the paused turn back. This bounds
 * how many times we do that before giving up on the batch.
 */
const MAX_PAUSE_RESUMES = 6;

/**
 * The research agent uses its OWN Anthropic key, ANTHROPIC_API_KEY_RESEARCH, so
 * its spend and rate limits are tracked separately from the Writing Agent's —
 * which keeps using the shared ANTHROPIC_API_KEY. Falls back to the shared key
 * when the research-specific one isn't set, and says so, so a missing var
 * degrades visibly instead of breaking the run.
 */
function resolveApiKey(): { key: string; source: string } {
  const dedicated = process.env.ANTHROPIC_API_KEY_RESEARCH;
  if (dedicated) return { key: dedicated, source: "ANTHROPIC_API_KEY_RESEARCH" };
  const shared = process.env.ANTHROPIC_API_KEY;
  if (shared) {
    return {
      key: shared,
      source: "ANTHROPIC_API_KEY (fallback — ANTHROPIC_API_KEY_RESEARCH is not set)",
    };
  }
  throw new Error(
    "No Anthropic key for the research agent. Set ANTHROPIC_API_KEY_RESEARCH (or ANTHROPIC_API_KEY) in worker/.env."
  );
}

// Created lazily so dotenv has already run by the time the key is read.
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const { key, source } = resolveApiKey();
    console.log(`[Research/Claude] API key: ${source}`);
    // maxRetries: 0 — retries are handled by our own withRetry wrapper, so they
    // aren't compounded with the SDK's and they log consistently.
    client = new Anthropic({ apiKey: key, maxRetries: 0 });
  }
  return client;
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

// ── System prompt (verbatim copy of the Perplexity agent's — keep in sync) ────

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

/**
 * Appended to the USER message — never to the system prompt, which stays a
 * verbatim copy of the Perplexity agent's. This is purely operational: it says
 * how to drive the search/fetch tools and changes no rule, no target, and no
 * output field. (Same pattern the Writing Agent uses for its LENGTH TARGET.)
 *
 * It is needed because the two providers differ mechanically: Perplexity's Sonar
 * models retrieve on every request automatically, while Claude decides for
 * itself whether to search at all — so without this a batch can come back
 * answered from memory, or off a single search, which is exactly the
 * thin-bundle failure this agent exists to fix.
 *
 * Delete this constant and the line that appends it to make the request
 * byte-identical to the Perplexity agent's.
 */
const TOOL_USE_DIRECTIVE = `RESEARCH PROCEDURE (how to operate your tools — this changes none of the rules, targets, or output format above):

You have web_search and web_fetch. Both are restricted at the API level to this request's slice of the approved source list, so anything they return is already on the allowlist. Work the whole slice rather than stopping at the first usable result:

1. Run several distinct searches, varying the phrasing and the angle (history, founding, dates, named people, figures and statistics, primary documents, contemporary coverage), so you reach more than one or two sites in the slice.
2. web_fetch the promising result pages and read them in full before extracting anything. Do not extract from search snippets alone — a snippet is where one-line facts come from; the full page is where the substantive notes are.
3. Mine each fetched page completely before moving to the next, and keep going until the slice is exhausted or there is genuinely nothing further to gain.

When you have finished searching and fetching, return the JSON object and nothing else.`;

/**
 * Allowlist entries for the API filter. Path-scoped entries ("github.com/Sefaria")
 * are narrowed to their host, since the tool filter matches on domain — the path
 * restriction is still enforced afterwards by isAllowedUrl, so nothing off-list
 * survives into the bundle.
 */
function toApiDomains(batch: string[]): string[] {
  return [...new Set(batch.map((d) => d.split("/")[0]))];
}

/** Text blocks only — server tool_use / tool_result blocks are not the answer. */
function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Live progress for one batch. A batch legitimately runs for minutes across a
 * couple of dozen server-side tool iterations, and without this the console is
 * completely silent for the whole time — leaving no way to tell a healthy run
 * from a hung one. Counts searches and fetches and stamps each line with
 * elapsed seconds, so a stall is visible as a gap.
 */
function attachProgressLogging(
  stream: { on: (event: "streamEvent", handler: (event: unknown) => void) => unknown },
  startedAt: number
): void {
  let searches = 0;
  let fetches = 0;
  const at = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;

  stream.on("streamEvent", (raw) => {
    const event = raw as { type?: string; content_block?: { type?: string; name?: string } };
    if (event.type !== "content_block_start") return;
    const block = event.content_block;
    switch (block?.type) {
      case "thinking":
        console.log(`[Research/Claude]   …thinking (${at()})`);
        break;
      // Branch on the tool NAME, not "anything that isn't web_fetch": the
      // _20260209 tools run dynamic filtering, which emits its own
      // code_execution server_tool_use blocks. Lumping those in with searches
      // made the counter overshoot max_uses and report searches that never
      // happened.
      case "server_tool_use":
        if (block.name === "web_fetch") {
          fetches++;
          console.log(
            `[Research/Claude]   …reading source page ${fetches}/${WEB_FETCH_MAX_USES} (${at()})`
          );
        } else if (block.name === "web_search") {
          searches++;
          console.log(
            `[Research/Claude]   …search ${searches}/${WEB_SEARCH_MAX_USES} (${at()})`
          );
        } else {
          console.log(`[Research/Claude]   …filtering results (${at()})`);
        }
        break;
      case "text":
        console.log(`[Research/Claude]   …writing the bundle (${at()})`);
        break;
    }
  });
}

// ── Claude call ───────────────────────────────────────────────────────────────

async function callClaude(
  input: ResearchInput,
  domainBatch: string[],
  officialSource?: string
): Promise<string> {
  const allowedDomains = toApiDomains(domainBatch);

  const userContent =
    JSON.stringify({
      topic: input.topic,
      // Only sent when the caller supplied it — otherwise the agent classifies
      // the topic itself and returns the category.
      ...(input.category ? { category: input.category } : {}),
      aliases: input.aliases ?? [],
      // Only sent when the caller supplied it — otherwise the tier is inferred
      // from the finished bundle rather than promised up front.
      ...(input.significance_tier ? { significance_tier: input.significance_tier } : {}),
      // Set only on the extra official-site call — authorizes the model to
      // extract facts from the topic's own (off-allowlist) domain.
      ...(officialSource ? { official_source: officialSource } : {}),
    }) + `\n\n${TOOL_USE_DIRECTIVE}`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: userContent },
  ];
  const texts: string[] = [];
  const startedAt = Date.now();

  for (let resume = 0; resume <= MAX_PAUSE_RESUMES; resume++) {
    const stream = getClient().beta.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        // Cached: the system prompt is byte-identical on every call, and every
        // pause/resume re-sends it. Note the cache prefix is tools → system →
        // messages, and `tools` carries this batch's allowed_domains — so the
        // hit is within a batch (across its resumes), not across batches.
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: EFFORT },
        // Safety classifiers can decline outright on this subject matter;
        // server-side fallback re-routes those instead of losing the batch.
        // Opus/Fable only — Sonnet 5 rejects the parameter outright.
        ...(SUPPORTS_FALLBACKS
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
        // API-level source restriction — enforced at the retrieval layer,
        // before the model sees any result.
        tools: [
          {
            type: "web_search_20260209",
            name: "web_search",
            max_uses: WEB_SEARCH_MAX_USES,
            allowed_domains: allowedDomains,
          },
          {
            type: "web_fetch_20260209",
            name: "web_fetch",
            max_uses: WEB_FETCH_MAX_USES,
            allowed_domains: allowedDomains,
            // Bounds how much of one page enters the conversation — see the
            // constant's comment for why this matters so much here.
            max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS,
          },
        ],
        messages,
      });

    attachProgressLogging(stream, startedAt);
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      // Deliberately worded so the retry classifier below recognizes it — a
      // refusal is deterministic, so retrying just burns another full call.
      throw new Error(
        `Claude declined this research request (refusal: ${
          message.stop_details?.category ?? "unspecified"
        })`
      );
    }

    const text = textOf(message.content);
    if (text.trim()) texts.push(text);

    // The server-side tool loop pauses every 10 iterations; hand the paused
    // turn back and it resumes where it left off. No extra user message — the
    // API detects the trailing server_tool_use block itself.
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    if (message.stop_reason === "max_tokens") {
      console.warn(
        "[Research/Claude] Response hit the max_tokens cap — JSON may be truncated; the salvage parser will keep every complete fact"
      );
    }
    if (texts.length === 0) {
      throw new Error("Claude response contained no text content");
    }
    if (texts.length > 1) {
      console.warn(
        `[Research/Claude] Model emitted text across ${texts.length} turns — concatenating before parsing`
      );
    }
    return texts.join("\n");
  }

  throw new Error(
    `Claude did not finish the batch within ${MAX_PAUSE_RESUMES} pause/resume rounds`
  );
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
 * Parse a research response, salvaging truncated JSON — cut back to the last
 * complete object and close whatever is still open, so every fully-emitted fact
 * survives. Exported for tests.
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
          "[Research/Claude] Response JSON was truncated/malformed — salvaged the complete portion"
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
 * Returns null if it doesn't look like a bare domain, so junk (a sentence,
 * "N/A") never triggers a bogus official-site call.
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
        console.warn(`[Research/Claude] Dropped fact with non-allowlisted source: ${url}`);
        continue;
      }
      if (isBlockedUrl(url)) {
        console.warn(`[Research/Claude] Dropped fact from blocked opinion/blog source: ${url}`);
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
        console.warn(
          `[Research/Claude] Dropped distinctive material with non-allowlisted source: ${url}`
        );
        continue;
      }
      if (isBlockedUrl(url)) {
        console.warn(
          `[Research/Claude] Dropped distinctive material from blocked opinion/blog source: ${url}`
        );
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

  // Preserve the "no answer" case as null — critical for truncated responses,
  // where the tier (a trailing field) is dropped and must NOT be miscounted.
  const tierVote: SignificanceTier | null =
    parsed.significance_tier === "major"
      ? "major"
      : parsed.significance_tier === "standard"
        ? "standard"
        : null;

  const categoryVote: TopicCategory | null =
    parsed.category === "person" ||
    parsed.category === "place" ||
    parsed.category === "event" ||
    parsed.category === "concept"
      ? parsed.category
      : null;

  const officialDomainVote = normalizeDomain(parsed.official_domain);

  return {
    topic: input.topic,
    category: input.category ?? categoryVote ?? "concept",
    facts,
    distinctive_material: distinctive,
    sources,
    confidence_score: confidenceScore,
    controversy_flags: controversyFlags,
    status,
    significance_tier: tierVote ?? "standard",
    tier_vote: tierVote,
    category_vote: categoryVote,
    official_domain_vote: officialDomainVote,
  };
}

/**
 * Decide the topic's significance tier when the caller didn't supply one, from
 * the breadth and depth of what was actually gathered. Thresholds are
 * deliberately conservative and heuristic — tune against real runs.
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

  const significanceTier = resolveSignificance(
    partials,
    input,
    facts,
    sources,
    flags
  );

  return {
    topic: input.topic,
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
 * is the primary signal (already calibrated conservative by the prompt's "when
 * in doubt, standard" rule, so a `major` vote is stronger evidence than a
 * `standard` one — hence a tie breaks to `major`). Batches that returned no
 * tier (e.g. truncated JSON) don't vote at all.
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

/** A refusal is deterministic — never worth a retry. */
function isRetryableResearchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/Claude declined this research request/.test(message)) return false;
  return isRetryableError(err);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run the Claude Research Agent for one topic: one Sonnet 5 call per domain batch
 * (each with web_search/web_fetch scoped to that batch), merged into a single
 * research_bundle. A failed batch is logged and skipped — the other batches
 * still contribute. Signature-compatible with runResearch() from
 * agents/research.ts, so the pipeline can use either.
 */
export async function runResearchClaude(input: ResearchInput): Promise<ResearchBundle> {
  console.log(
    `[Research/Claude] "${input.topic}" (${input.category ?? "category: auto"}) — ` +
      `${DOMAIN_BATCHES.length} domain batches on ${CLAUDE_MODEL}`
  );

  const partials: PartialBundle[] = [];
  let failedBatches = 0;

  for (let i = 0; i < DOMAIN_BATCHES.length; i++) {
    const batch = DOMAIN_BATCHES[i];
    try {
      const raw = await withRetry(() => callClaude(input, batch), {
        label: `Claude research batch ${i + 1}/${DOMAIN_BATCHES.length}`,
        isRetryable: isRetryableResearchError,
      });
      const partial = normalizePartial(raw, input);
      partials.push(partial);
      console.log(
        `[Research/Claude] Batch ${i + 1}/${DOMAIN_BATCHES.length} (${batch.length} domains): ` +
          `${partial.facts.length} facts, ${partial.distinctive_material.length} distinctive, status=${partial.status}`
      );
    } catch (err) {
      failedBatches++;
      console.error(`[Research/Claude] Batch ${i + 1}/${DOMAIN_BATCHES.length} failed:`, err);
    }
  }

  if (partials.length === 0) {
    throw new Error(
      `All ${DOMAIN_BATCHES.length} research batches failed for "${input.topic}"`
    );
  }
  if (failedBatches > 0) {
    console.warn(
      `[Research/Claude] ${failedBatches} batch(es) failed — bundle built from the remaining ${partials.length}`
    );
  }

  // The topic's own official site (auto-detected). If a batch surfaced a domain
  // that isn't already on the allowlist, make ONE extra call scoped to it and
  // fold its facts in. Non-site topics report none, so this never fires for them.
  const officialDomain = resolveOfficialDomain(partials);
  if (officialDomain && !isAllowedUrl(`https://${officialDomain}/`)) {
    try {
      const raw = await withRetry(() => callClaude(input, [officialDomain], officialDomain), {
        label: `Claude official-site call (${officialDomain})`,
        isRetryable: isRetryableResearchError,
      });
      const partial = normalizePartial(raw, input, officialDomain);
      partials.push(partial);
      console.log(
        `[Research/Claude] Official-site call (${officialDomain}): ${partial.facts.length} facts, ` +
          `${partial.distinctive_material.length} distinctive`
      );
    } catch (err) {
      console.error(`[Research/Claude] Official-site call for "${officialDomain}" failed:`, err);
    }
  }

  const bundle = mergeBundles(partials, input);
  const opinionFacts = bundle.facts.filter((f) => f.source_type === "opinion_commentary").length;
  console.log(
    `[Research/Claude] Merged bundle for "${input.topic}": ${bundle.facts.length} facts ` +
      `(${opinionFacts} opinion/commentary), ${bundle.sources.length} sources, ` +
      `confidence=${bundle.confidence_score}, tier=${bundle.significance_tier}, status=${bundle.status}`
  );
  return bundle;
}
