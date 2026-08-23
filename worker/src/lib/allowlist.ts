/**
 * Approved source allowlist for the IsraelPedia Research Agent.
 *
 * These domains are enforced at the RETRIEVAL level via Perplexity's
 * `search_domain_filter` request parameter — not just in the prompt.
 *
 * Perplexity caps `search_domain_filter` at 20 domains per request
 * (verified against https://docs.perplexity.ai/guides/search-domain-filters,
 * July 2026: "You can add a maximum of 20 domains to the search_domain_filter
 * list"). The full allowlist exceeds that cap, so it is packed into batches
 * of ≤20 and the Research Agent makes one call per batch, merging results.
 *
 * Domain format notes (from the same docs):
 * - Bare domains, no protocol ("nature.com", not "https://nature.com").
 * - A root domain matches all its subdomains — so a single "gov.il" entry
 *   covers every official Israeli government site (mfa.gov.il, knesset.gov.il,
 *   cbs.gov.il, archives.gov.il, etc.).
 * - Path filters are supported ("github.com/Sefaria" matches only that org).
 */

/**
 * Editorial source-type taxonomy (Round-2 recommendation 1.1). Every fact the
 * Research Agent returns is tagged with one of these so the Writing and QA
 * agents can treat opinion/commentary differently from reported or documentary
 * sourcing without hardcoding per-domain logic downstream.
 */
export type SourceType =
  | "news"
  | "opinion_commentary"
  | "academic"
  | "official_record"
  | "reference"
  | "advocacy_research";

export interface DomainGroup {
  name: string;
  /**
   * The default source_type for pages on these domains. Note this is a
   * *domain-level default*: the per-page classifier (classifySourceType) can
   * still upgrade an individual news URL to "opinion_commentary" when the path
   * shows it's an op-ed/column/blog.
   */
  sourceType: SourceType;
  domains: string[];
}

export const DOMAIN_GROUPS: DomainGroup[] = [
  {
    name: "Reference/Encyclopedic",
    sourceType: "reference",
    domains: [
      "jewishvirtuallibrary.org",
      "jewishencyclopedia.com",
      "encyclopedia.com",
      "myjewishlearning.com",
      "encyclopedia.yivo.org",
      "yivo.org",
    ],
  },
  {
    name: "News",
    sourceType: "news",
    domains: ["timesofisrael.com", "jpost.com", "jns.org"],
  },
  {
    name: "Libraries/Archives/Primary Sources",
    sourceType: "official_record",
    domains: [
      "nli.org.il",
      "israeled.org",
      "archives.gov.il",
      "archives.gov",
      "loc.gov",
      "avalon.law.yale.edu",
      "digitallibrary.un.org",
      "nationalarchives.gov.uk",
      "sefaria.org",
      "developers.sefaria.org",
      "github.com/Sefaria",
    ],
  },
  {
    name: "Demographics",
    sourceType: "academic",
    domains: ["pewresearch.org", "jewishdatabank.org"],
  },
  {
    name: "Jewish Organizations",
    sourceType: "advocacy_research",
    domains: [
      "jewishagency.org",
      "worldjewishcongress.org",
      "ajc.org",
      "adl.org",
      "jimena.org",
    ],
  },
  {
    name: "Holocaust Education",
    sourceType: "reference",
    domains: [
      "ushmm.org",
      "encyclopedia.ushmm.org",
      "yadvashem.org",
      "echoesandreflections.org",
      "sfi.usc.edu",
      "holocaustremembrance.com",
    ],
  },
  {
    // A single "gov.il" entry covers every official Israeli government
    // subdomain (mfa, knesset, cbs, archives, etc.).
    name: "Israeli Government",
    sourceType: "official_record",
    domains: ["gov.il"],
  },
  {
    name: "US Government",
    sourceType: "official_record",
    domains: [
      "state.gov",
      "treasury.gov",
      "justice.gov",
      "fbi.gov",
      "federalregister.gov",
      "congress.gov",
      "uscode.house.gov",
      "everycrsreport.com",
    ],
  },
  {
    name: "Counterterrorism/Security Research",
    sourceType: "advocacy_research",
    domains: [
      "terrorism-info.org.il",
      "memri.org",
      "palwatch.org",
      "impact-se.org",
      "longwarjournal.org",
      "washingtoninstitute.org",
      "ctc.westpoint.edu",
      "counterextremism.com",
      "fdd.org",
      "inss.org.il",
      "jcpa.org",
    ],
  },
  {
    name: "Media Monitoring/Advocacy",
    sourceType: "advocacy_research",
    domains: [
      "camera.org",
      "camera-uk.org",
      "camera-arabic.org",
      "honestreporting.com",
      "ngo-monitor.org",
      "unwatch.org",
      "jewishonliner.org",
      "uklfi.com",
      "thelawfareproject.org",
    ],
  },
  {
    name: "Primary Historical Texts (Zionism)",
    sourceType: "reference",
    domains: ["gutenberg.org", "archive.org", "jabotinsky.org"],
  },
  {
    name: "Jewish Intellectual Journals",
    // Essay/commentary by design — none of this is edited news reporting, so
    // it is locked to opinion_commentary regardless of the model's own guess.
    sourceType: "opinion_commentary",
    domains: [
      "ideas.tikvah.org",
      "sapirjournal.org",
      "jewishreviewofbooks.com",
      "traditiononline.org",
      "hakirah.org",
      "jewish-faculty.biu.ac.il",
      "jcfa.org",
    ],
  },
  {
    name: "Academic",
    sourceType: "academic",
    domains: [
      "harman.huji.ac.il",
      "en-social-sciences.tau.ac.il",
      "bermanarchive.stanford.edu",
      "bjpa.org",
      "americanjewisharchives.org",
      "jpr.org.uk",
      "huc.edu",
      "cris.bgu.ac.il",
      "aisisraelstudies.org",
    ],
  },
  {
    name: "Other",
    sourceType: "reference",
    domains: ["jewishheritagemonth.gov"],
  },
];

export const ALL_DOMAINS: string[] = DOMAIN_GROUPS.flatMap((g) => g.domains);

/** Perplexity's per-request cap on search_domain_filter entries. */
export const SEARCH_DOMAIN_FILTER_CAP = 20;

/**
 * Pack the domain groups into batches of ≤ SEARCH_DOMAIN_FILTER_CAP domains,
 * keeping each thematic group intact within a single batch.
 */
function buildBatches(cap: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];

  for (const group of DOMAIN_GROUPS) {
    if (group.domains.length > cap) {
      throw new Error(
        `Domain group "${group.name}" has ${group.domains.length} domains, exceeding the per-request cap of ${cap}.`
      );
    }
    if (current.length + group.domains.length > cap) {
      batches.push(current);
      current = [];
    }
    current.push(...group.domains);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export const DOMAIN_BATCHES: string[][] = buildBatches(SEARCH_DOMAIN_FILTER_CAP);

/** True if a single allowlist entry (bare domain or path-scoped) matches. */
function entryMatches(entry: string, host: string, hostAndPath: string): boolean {
  const e = entry.toLowerCase();
  if (e.includes("/")) {
    // Path-scoped entry like "github.com/Sefaria"
    return hostAndPath.startsWith(e) || hostAndPath.startsWith(`www.${e}`);
  }
  return host === e || host.endsWith(`.${e}`);
}

/** Parse a URL into the lowercased host / host+path pair the matchers use. */
function urlParts(rawUrl: string): { host: string; hostAndPath: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return { host, hostAndPath: `${host}${url.pathname}`.toLowerCase() };
}

/**
 * Defense-in-depth: verify a returned source URL actually belongs to the
 * allowlist. The retrieval-level filter should guarantee this, but the model
 * could still emit a URL from general knowledge — those get dropped.
 */
export function isAllowedUrl(rawUrl: string): boolean {
  const parts = urlParts(rawUrl);
  if (!parts) return false;
  return ALL_DOMAINS.some((entry) => entryMatches(entry, parts.host, parts.hostAndPath));
}

/**
 * Explicit blocklist checked AFTER the allowlist (Round-2 recommendation 1.1).
 * Some allowlisted apex domains host a separate opinion/blog platform that the
 * retrieval-level `search_domain_filter` cannot exclude on its own (a root
 * domain filter matches all subdomains). The clearest case is Times of Israel's
 * blogging platform, which is user-contributed commentary, not edited reporting.
 * Any URL matching an entry here is rejected outright even though its apex
 * domain is allowlisted.
 */
const BLOCKED_ENTRIES: string[] = [
  "blogs.timesofisrael.com",
  "timesofisrael.com/spotlight", // ToI's sponsored/branded-content section
];

export function isBlockedUrl(rawUrl: string): boolean {
  const parts = urlParts(rawUrl);
  if (!parts) return false;
  return BLOCKED_ENTRIES.some((entry) => entryMatches(entry, parts.host, parts.hostAndPath));
}

/** The allowlist group a URL belongs to (by name), if any. */
export function sourceGroupName(rawUrl: string): string | undefined {
  const parts = urlParts(rawUrl);
  if (!parts) return undefined;
  const group = DOMAIN_GROUPS.find((g) =>
    g.domains.some((entry) => entryMatches(entry, parts.host, parts.hostAndPath))
  );
  return group?.name;
}

/** The domain-level default source_type for a URL, if it's on the allowlist. */
function domainBaseType(rawUrl: string): SourceType | undefined {
  const parts = urlParts(rawUrl);
  if (!parts) return undefined;
  const group = DOMAIN_GROUPS.find((g) =>
    g.domains.some((entry) => entryMatches(entry, parts.host, parts.hostAndPath))
  );
  return group?.sourceType;
}

const VALID_SOURCE_TYPES: readonly SourceType[] = [
  "news",
  "opinion_commentary",
  "academic",
  "official_record",
  "reference",
  "advocacy_research",
];

function asSourceType(v: unknown): SourceType | undefined {
  return typeof v === "string" && (VALID_SOURCE_TYPES as readonly string[]).includes(v)
    ? (v as SourceType)
    : undefined;
}

/**
 * Path/subdomain patterns that mark a NEWS page as opinion/commentary — op-eds,
 * columns, blogs. Deliberately conservative: only unambiguous editorial-section
 * markers, and only ever applied to news domains (see classifySourceType), so a
 * court's "/opinions/" or a think tank's "/policy-analysis/" is never
 * misread as commentary.
 */
const OPINION_PATH = /\/(opinion|opinions|op-ed|oped|blogs?|columnists?|columns)(\/|$|-|\.)/;
const OPINION_SUBDOMAIN = /(^|\.)blogs?\./;

/**
 * Decide a fact's source_type. The domain default is authoritative for
 * inherently-commentary domains (the Jewish Intellectual Journals) and is the
 * fallback everywhere else, but a news page can be *upgraded* to
 * opinion_commentary two ways: (a) its URL path/subdomain shows it's an
 * op-ed/column/blog, or (b) the model — which actually read the page — tagged
 * it opinion_commentary. Both upgrades apply only to news (or unknown) domains,
 * so an "opinion"/"analysis" path on a court, government, or research site keeps
 * its documentary type. The model's hint can only ever make a source MORE
 * cautious (news → opinion), never launder a commentary journal into "news".
 */
export function classifySourceType(rawUrl: string, modelHint?: unknown): SourceType {
  const base = domainBaseType(rawUrl);
  const hint = asSourceType(modelHint);

  // Journals etc. are locked to opinion regardless of anything else.
  if (base === "opinion_commentary") return "opinion_commentary";

  // Editorial-section detection applies only to news (or unknown) domains.
  if (base === "news" || base === undefined) {
    const parts = urlParts(rawUrl);
    if (parts && (OPINION_SUBDOMAIN.test(parts.host) || OPINION_PATH.test(parts.hostAndPath))) {
      return "opinion_commentary";
    }
    if (hint === "opinion_commentary") return "opinion_commentary";
  }

  if (base) return base;
  // Unknown domain (shouldn't happen post-allowlist): fall back to the model's
  // hint, else the most neutral bucket.
  return hint ?? "reference";
}
