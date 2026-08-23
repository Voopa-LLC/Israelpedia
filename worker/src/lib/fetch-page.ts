/**
 * Web page fetcher + text extraction, used by the QA Agent's fetch_url tool to
 * independently verify cited sources. Handles both HTML (conservative
 * tag-stripping) and PDF (real text extraction via unpdf) — many allowlisted
 * academic/government sources are PDFs, and returning their raw bytes used to
 * leave those citations unverifiable. Kept in lib/ so any future agent that
 * needs to read a page can reuse it.
 *
 * Failures are returned as values (ok: false), never thrown — per the QA spec,
 * a fetch failure means "source_unverifiable", not an error that kills the run.
 */
import { getDocumentProxy, extractText } from "unpdf";

const FETCH_TIMEOUT_MS = 20_000;
/** Large academic PDFs on slow hosts routinely need longer than an HTML page. */
const PDF_FETCH_TIMEOUT_MS = 45_000;
/**
 * Hard cap on extracted text kept in memory and returned. The QA layer windows
 * this down further (optionally around a search query), so this only bounds the
 * worst case for a huge document.
 */
const FULL_TEXT_HARD_CAP = 500_000;

export interface PageFetchResult {
  ok: boolean;
  url: string;
  /** Extracted readable text when ok; an error description when not. */
  text: string;
  /**
   * Whether a failure is worth retrying. Timeouts and network errors are
   * transient (retryable); HTTP 4xx and "no text extracted" are deterministic —
   * a second identical request just fails the same way. Always false when ok.
   */
  retryable: boolean;
}

/** A URL whose path ends in .pdf — used to grant a longer fetch timeout. */
function looksLikePdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(url);
  }
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** Strip an HTML document down to readable text. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level closers and <br> become line breaks so the text keeps
    // paragraph structure the model can read.
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeEntities(stripped)
    .replace(/[ \t\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True if the first bytes are the PDF magic number "%PDF-". */
function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

/** Extract readable text from PDF bytes; returns "" if extraction fails. */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const doc = await getDocumentProxy(bytes);
    const { text } = await extractText(doc, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n") : text;
    return joined
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    console.warn(
      `[fetch] PDF text extraction failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return "";
  }
}

/**
 * Fetch one page and extract its readable text (HTML or PDF). One attempt —
 * the caller decides on retries (the QA Agent retries once, then marks the
 * source unverifiable). Returns the full extracted text (capped only at the
 * hard memory limit); the caller windows it down.
 */
export async function fetchPageText(url: string): Promise<PageFetchResult> {
  const timeoutMs = looksLikePdfUrl(url) ? PDF_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; IsraelPediaQA/1.0; citation verification)",
        Accept:
          "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        url,
        text: `HTTP ${response.status} ${response.statusText}`,
        // 5xx can be transient and is worth one retry; 4xx is a definitive
        // client-side rejection (403/404/410…) that will never change on retry.
        retryable: response.status >= 500,
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isPdf = contentType.includes("pdf") || looksLikePdfUrl(url) || hasPdfMagic(bytes);

    let text: string;
    if (isPdf) {
      text = await extractPdfText(bytes);
      if (!text) {
        return {
          ok: false,
          url,
          text: "PDF fetched but no readable text could be extracted",
          retryable: false,
        };
      }
    } else {
      const body = new TextDecoder("utf-8").decode(bytes);
      const looksLikeHtml = contentType.includes("html") || /<[a-z][\s\S]*>/i.test(body);
      text = looksLikeHtml ? htmlToText(body) : body.trim();
    }

    if (!text) {
      return {
        ok: false,
        url,
        text: "Page fetched but no readable text could be extracted",
        retryable: false,
      };
    }
    return {
      ok: true,
      url,
      retryable: false,
      text: text.length > FULL_TEXT_HARD_CAP ? text.slice(0, FULL_TEXT_HARD_CAP) : text,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? `Timed out after ${timeoutMs}ms`
          : err.message
        : String(err);
    // Timeouts and network-level errors are transient — one retry is worthwhile.
    return { ok: false, url, text: message, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
