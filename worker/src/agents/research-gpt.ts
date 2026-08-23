/**
 * IsraelPedia Research Agent — OpenAI / GPT variant.
 *
 * The third drop-in alternative to the Perplexity Research Agent
 * (agents/research.ts), alongside the Claude one (agents/research-claude.ts).
 * Same job, same system prompt, same input, same `research_bundle` output — the
 * only difference is the provider: GPT-5.6 Sol driving OpenAI's server-side
 * `web_search` tool plus our own `fetch_url` tool, instead of `sonar-pro`.
 *
 * Model: `gpt-5.6-sol` — OpenAI's flagship reasoning tier (verified against
 * https://developers.openai.com/api/docs/models, August 2026; the bare
 * `gpt-5.6` alias resolves to it). Reasoning effort "high", via the Responses
 * API with streaming, the same plumbing the QA Agent uses.
 *
 * Two tools, deliberately:
 *   • web_search  — server-side discovery, restricted at the API level by
 *     `filters.allowed_domains`, so retrieval is scoped before the model sees
 *     anything. OpenAI's cap is 100 domains, comfortably above our 82.
 *   • fetch_url   — our own reader (lib/fetch-page.ts, shared with the QA
 *     Agent). Search returns snippets; this returns the FULL page, and it reads
 *     PDFs via unpdf — which matters because a lot of the allowlist's
 *     government and academic material is PDF-only and is otherwise invisible.
 *     Every requested URL is re-checked against the allowlist before any
 *     network call, so this tool can never widen the source restriction.
 *
 * Note on batching: unlike Perplexity's hard 20-domain cap, the entire
 * allowlist would fit in a single call here. The same DOMAIN_BATCHES split is
 * kept anyway, for two reasons — forcing a separate pass over each thematic
 * source group is what produces breadth instead of the model settling on
 * whichever two sites answer first, and keeping the call structure identical
 * across all three agents is what makes a head-to-head comparison fair.
 *
 * NOTE: the parsing/normalization/merge logic below is a deliberate duplicate of
 * agents/research.ts so the agents stay independently editable. If you fix a bug
 * in one, fix it in the others.
 */
import {
  DOMAIN_BATCHES,
  isAllowedUrl,
  isBlockedUrl,
  classifySourceType,
  sourceGroupName,
} from "../lib/allowlist";
import { fetchPageText, PageFetchResult } from "../lib/fetch-page";
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

// Re-exported so callers can import the whole contract from any research agent.
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

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
/** Flagship reasoning tier. The bare "gpt-5.6" alias resolves here. */
const GPT_MODEL = "gpt-5.6-sol";
const REASONING_EFFORT = "high";
/** How much page content web_search hands back per result. */
const SEARCH_CONTEXT_SIZE = "high";
/** Bound on total output (incl. reasoning) tokens per API round. */
const MAX_OUTPUT_TOKENS = 32_000;
/** Hard ceilings so a misbehaving batch can't loop forever. */
const MAX_ROUNDS = 20;
/** Per-batch fetch_url budget — the depth lever, mirrors the Claude agent's. */
const MAX_FETCH_CALLS = 12;
/** Per-round timeout: high reasoning over several fetched pages takes minutes. */
const API_TIMEOUT_MS = 15 * 60_000;
/** Cap on page text handed back to the model per fetch — controls token cost. */
const MAX_FETCH_TEXT_CHARS = 15_000;

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
 * verbatim copy of the Perplexity agent's. Purely operational: it says how to
 * drive the two tools and changes no rule, no target, and no output field.
 * (Same pattern the Writing Agent uses for its LENGTH TARGET, and the same
 * directive the Claude research agent carries.)
 *
 * It is needed because the providers differ mechanically: Perplexity's Sonar
 * models retrieve on every request automatically, while GPT decides for itself
 * whether to search at all — so without this a batch can come back answered
 * from memory, or off a single search, which is exactly the thin-bundle failure
 * this agent exists to fix.
 *
 * Delete this constant and the line that appends it to make the request
 * byte-identical to the Perplexity agent's.
 */
const TOOL_USE_DIRECTIVE = `RESEARCH PROCEDURE (how to operate your tools — this changes none of the rules, targets, or output format above):

You have web_search and fetch_url. web_search is restricted at the API level to this request's slice of the approved source list, so anything it returns is already on the allowlist. Work the whole slice rather than stopping at the first usable result:

1. Run several distinct searches, varying the phrasing and the angle (history, founding, dates, named people, figures and statistics, primary documents, contemporary coverage), so you reach more than one or two sites in the slice.
2. Call fetch_url on the promising result pages and read them in full before extracting anything. Do not extract from search snippets alone — a snippet is where one-line facts come from; the full page is where the substantive notes are. fetch_url reads PDFs as well as HTML, and takes an optional "find" argument that returns the passage around a phrase when the page is long.
3. Mine each fetched page completely before moving to the next, and keep going until the slice is exhausted or there is genuinely nothing further to gain.

When you have finished searching and fetching, return the JSON object and nothing else.`;

// ── fetch_url tool ────────────────────────────────────────────────────────────

const FETCH_URL_TOOL = {
  type: "function",
  name: "fetch_url",
  description:
    "Fetch an approved source page or PDF by URL and return its full extracted readable text, so you can mine it for substantive facts instead of relying on a search snippet. Handles both HTML and PDF. Results are cached per URL.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The absolute URL of the approved source page or PDF to read",
      },
      find: {
        type: ["string", "null"],
        description:
          "Optional: a short phrase you expect on the page. On a long page or PDF the tool returns the passage around it instead of only the top. Pass null if not needed.",
      },
    },
    required: ["url", "find"],
    additionalProperties: false,
  },
  strict: true,
} as const;

/**
 * Window a long page down to the model's budget. With a `find` query, return
 * the passage around the first match (plus the document head for context) so a
 * fact deep in a long page or PDF isn't lost to top-only truncation.
 */
function windowText(full: string, find?: string): string {
  if (full.length <= MAX_FETCH_TEXT_CHARS) return full;
  if (find) {
    const needle = find.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
    const idx = needle ? full.toLowerCase().indexOf(needle) : -1;
    if (idx >= 0) {
      const headLen = 2000;
      const radius = Math.floor((MAX_FETCH_TEXT_CHARS - headLen) / 2);
      const start = Math.max(headLen, idx - radius);
      const end = Math.min(full.length, idx + radius);
      return (
        `${full.slice(0, headLen)}\n[...]\n${full.slice(start, end)}\n` +
        `[...document truncated; the excerpt above is the region matching your "find" query...]`
      );
    }
  }
  return (
    `${full.slice(0, MAX_FETCH_TEXT_CHARS)}\n[...truncated at ${MAX_FETCH_TEXT_CHARS} characters — ` +
    `if the fact you need is deeper in the page, call fetch_url again with a "find" argument...]`
  );
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
 * Execute one fetch_url call. The URL is re-checked against the allowlist
 * BEFORE any network call — web_search is already domain-filtered, but this
 * tool takes a free-text URL, so without this check it would be a hole straight
 * through the source restriction. Network fetches are deduped per URL across
 * the whole batch and retried once on a transient failure.
 */
async function executeFetchUrl(
  url: string,
  find: string | undefined,
  cache: Map<string, PageFetchResult>,
  extraAllowedDomain?: string
): Promise<{ ok: boolean; url: string; text: string }> {
  const key = url.trim();

  const permitted =
    isAllowedUrl(key) ||
    (extraAllowedDomain ? hostMatchesDomain(key, extraAllowedDomain) : false);
  if (!permitted || isBlockedUrl(key)) {
    console.warn(`[Research/GPT] Refused fetch of non-allowlisted URL: ${key}`);
    return {
      ok: false,
      url: key,
      text:
        "This URL is not on the approved source list, so it cannot be read and nothing from it may be used. Use an approved source instead.",
    };
  }

  let full = cache.get(key);
  if (full) {
    console.log(`[Research/GPT] fetch_url (cached): ${key}`);
  } else {
    let result = await fetchPageText(key);
    if (!result.ok && result.retryable) {
      console.warn(`[Research/GPT] fetch_url failed (${result.text}) — retrying once: ${key}`);
      result = await fetchPageText(key);
    }
    cache.set(key, result);
    full = result;
    console.log(`[Research/GPT] fetch_url: ${key} → ${result.ok ? "ok" : `FAILED (${result.text})`}`);
  }

  if (!full.ok) return { ok: false, url: full.url, text: full.text };
  return { ok: true, url: full.url, text: windowText(full.text, find) };
}

// ── OpenAI Responses API plumbing (mirrors the QA Agent's) ────────────────────

/**
 * The research agent uses its OWN OpenAI key, OPENAI_API_KEY_RESEARCH, so its
 * spend and rate limits are tracked separately from the QA Agent's — which
 * keeps using the shared OPENAI_API_KEY. Falls back to the shared key when the
 * research-specific one isn't set, and says so once, so a missing var degrades
 * visibly instead of breaking the run.
 */
let apiKeyCache: string | null = null;
function resolveApiKey(): string {
  if (apiKeyCache) return apiKeyCache;

  const dedicated = process.env.OPENAI_API_KEY_RESEARCH;
  if (dedicated) {
    console.log("[Research/GPT] API key: OPENAI_API_KEY_RESEARCH");
    apiKeyCache = dedicated;
    return apiKeyCache;
  }
  const shared = process.env.OPENAI_API_KEY;
  if (shared) {
    console.log(
      "[Research/GPT] API key: OPENAI_API_KEY (fallback — OPENAI_API_KEY_RESEARCH is not set)"
    );
    apiKeyCache = shared;
    return apiKeyCache;
  }
  throw new Error(
    "No OpenAI key for the research agent. Set OPENAI_API_KEY_RESEARCH (or OPENAI_API_KEY) in worker/.env."
  );
}

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
 * event and a hard timeout bounds the round.
 */
async function callResponsesApiOnce(body: Record<string, unknown>): Promise<ResponsesApiResult> {
  const apiKey = resolveApiKey();

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
        item?: { type?: string; action?: { type?: string } };
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
            console.log("[Research/GPT]   …model is reasoning");
          } else if (event.item?.type === "web_search_call") {
            console.log("[Research/GPT]   …model is searching approved sources");
          } else if (event.item?.type === "function_call") {
            console.log("[Research/GPT]   …model is requesting a page read");
          } else if (event.item?.type === "message") {
            console.log("[Research/GPT]   …model is writing the bundle");
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
    // "incomplete" usually means the output-token cap was hit; the bundle JSON
    // may be truncated but salvageable, so let the caller try to parse it.
    if (data.status === "incomplete") {
      console.warn(
        `[Research/GPT] Response incomplete (${data.incomplete_details?.reason ?? "unknown reason"}) — ` +
          `JSON may be truncated; the salvage parser will keep every complete fact`
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
 * Call the Responses API with backoff-spaced retries on transient failures. A
 * genuine per-round timeout is NOT retried — that would just burn another full
 * high-reasoning round.
 */
async function callResponsesApi(body: Record<string, unknown>): Promise<ResponsesApiResult> {
  return withRetry(() => callResponsesApiOnce(body), {
    label: `${GPT_MODEL} research call`,
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

// ── One batch: drive the tool loop until the model returns the bundle ─────────

async function runBatch(
  input: ResearchInput,
  domainBatch: string[],
  officialSource?: string
): Promise<string> {
  // Path-scoped allowlist entries ("github.com/Sefaria") are narrowed to their
  // host for the API filter; isAllowedUrl still enforces the path afterwards.
  const allowedDomains = [...new Set(domainBatch.map((d) => d.split("/")[0]))];

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

  const baseRequest = {
    model: GPT_MODEL,
    reasoning: { effort: REASONING_EFFORT },
    instructions: SYSTEM_PROMPT,
    tools: [
      {
        type: "web_search",
        // API-level source restriction — enforced at the retrieval layer,
        // before the model sees any result. OpenAI's cap is 100 domains.
        filters: { allowed_domains: allowedDomains },
        search_context_size: SEARCH_CONTEXT_SIZE,
      },
      FETCH_URL_TOOL,
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  let request: Record<string, unknown> = {
    ...baseRequest,
    input: [{ role: "user", content: userContent }],
  };

  const fetchCache = new Map<string, PageFetchResult>();
  let fetchCalls = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await callResponsesApi(request);
    const output = response.output ?? [];
    const functionCalls = output.filter((item) => item.type === "function_call");

    if (functionCalls.length === 0) {
      const text = extractOutputText(output);
      if (!text) throw new Error("GPT response contained no output text");
      return text;
    }

    const toolOutputs: Record<string, unknown>[] = [];
    for (const call of functionCalls) {
      let outputPayload: Record<string, unknown>;

      if (call.name !== "fetch_url") {
        outputPayload = { ok: false, error: `Unknown tool "${call.name}"` };
      } else if (++fetchCalls > MAX_FETCH_CALLS) {
        outputPayload = {
          ok: false,
          error: `Page-read budget (${MAX_FETCH_CALLS}) exhausted for this batch — extract what you can from the pages you already read, plus search results, and return the JSON bundle now.`,
        };
      } else {
        let url = "";
        let find: string | undefined;
        try {
          const args = JSON.parse(call.arguments ?? "{}") as { url?: unknown; find?: unknown };
          url = typeof args.url === "string" ? args.url.trim() : "";
          find = typeof args.find === "string" && args.find.trim() ? args.find.trim() : undefined;
        } catch {
          /* fall through to the error below */
        }
        if (!url) {
          outputPayload = { ok: false, error: "fetch_url called without a valid url argument" };
        } else {
          const result = await executeFetchUrl(url, find, fetchCache, officialSource);
          outputPayload = result.ok
            ? { ok: true, url: result.url, page_text: result.text }
            : { ok: false, url: result.url, error: result.text };
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

  throw new Error(`GPT batch did not finish within ${MAX_ROUNDS} tool rounds`);
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
          "[Research/GPT] Response JSON was truncated/malformed — salvaged the complete portion"
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
        console.warn(`[Research/GPT] Dropped fact with non-allowlisted source: ${url}`);
        continue;
      }
      if (isBlockedUrl(url)) {
        console.warn(`[Research/GPT] Dropped fact from blocked opinion/blog source: ${url}`);
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
          `[Research/GPT] Dropped distinctive material with non-allowlisted source: ${url}`
        );
        continue;
      }
      if (isBlockedUrl(url)) {
        console.warn(
          `[Research/GPT] Dropped distinctive material from blocked opinion/blog source: ${url}`
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

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Run the GPT Research Agent for one topic: one gpt-5.6-sol tool loop per domain
 * batch (each with web_search scoped to that batch and fetch_url for full page
 * reads), merged into a single research_bundle. A failed batch is logged and
 * skipped — the other batches still contribute. Signature-compatible with
 * runResearch() and runResearchClaude(), so the pipeline can use any of them.
 */
export async function runResearchGPT(input: ResearchInput): Promise<ResearchBundle> {
  console.log(
    `[Research/GPT] "${input.topic}" (${input.category ?? "category: auto"}) — ` +
      `${DOMAIN_BATCHES.length} domain batches on ${GPT_MODEL}`
  );

  const partials: PartialBundle[] = [];
  let failedBatches = 0;

  for (let i = 0; i < DOMAIN_BATCHES.length; i++) {
    const batch = DOMAIN_BATCHES[i];
    const startedAt = Date.now();
    try {
      console.log(
        `[Research/GPT] Batch ${i + 1}/${DOMAIN_BATCHES.length} (${batch.length} domains) — ` +
          `high reasoning, this step can take several minutes`
      );
      const raw = await runBatch(input, batch);
      const partial = normalizePartial(raw, input);
      partials.push(partial);
      console.log(
        `[Research/GPT] Batch ${i + 1}/${DOMAIN_BATCHES.length} done in ` +
          `${Math.round((Date.now() - startedAt) / 1000)}s: ${partial.facts.length} facts, ` +
          `${partial.distinctive_material.length} distinctive, status=${partial.status}`
      );
    } catch (err) {
      failedBatches++;
      console.error(`[Research/GPT] Batch ${i + 1}/${DOMAIN_BATCHES.length} failed:`, err);
    }
  }

  if (partials.length === 0) {
    throw new Error(
      `All ${DOMAIN_BATCHES.length} research batches failed for "${input.topic}"`
    );
  }
  if (failedBatches > 0) {
    console.warn(
      `[Research/GPT] ${failedBatches} batch(es) failed — bundle built from the remaining ${partials.length}`
    );
  }

  // The topic's own official site (auto-detected). If a batch surfaced a domain
  // that isn't already on the allowlist, make ONE extra call scoped to it and
  // fold its facts in. Non-site topics report none, so this never fires for them.
  const officialDomain = resolveOfficialDomain(partials);
  if (officialDomain && !isAllowedUrl(`https://${officialDomain}/`)) {
    try {
      const raw = await runBatch(input, [officialDomain], officialDomain);
      const partial = normalizePartial(raw, input, officialDomain);
      partials.push(partial);
      console.log(
        `[Research/GPT] Official-site call (${officialDomain}): ${partial.facts.length} facts, ` +
          `${partial.distinctive_material.length} distinctive`
      );
    } catch (err) {
      console.error(`[Research/GPT] Official-site call for "${officialDomain}" failed:`, err);
    }
  }

  const bundle = mergeBundles(partials, input);
  const opinionFacts = bundle.facts.filter((f) => f.source_type === "opinion_commentary").length;
  console.log(
    `[Research/GPT] Merged bundle for "${input.topic}": ${bundle.facts.length} facts ` +
      `(${opinionFacts} opinion/commentary), ${bundle.sources.length} sources, ` +
      `confidence=${bundle.confidence_score}, tier=${bundle.significance_tier}, status=${bundle.status}`
  );
  return bundle;
}
