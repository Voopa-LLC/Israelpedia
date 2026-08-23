/**
 * Generic retry-with-exponential-backoff wrapper for the LLM API calls
 * (Perplexity, Anthropic, OpenAI). Long-lived model requests — especially the
 * streaming, high-reasoning QA call — periodically get their connection reset
 * mid-flight (ECONNRESET / "terminated"), or hit a transient 429/5xx. A single
 * immediate retry isn't enough; a few attempts spaced out with backoff rides
 * out the blip. Deterministic failures (4xx other than 429) are NOT retried —
 * they'd just fail identically and waste time and money.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether an error is worth retrying. Network/transport failures and
 * transient server responses (429, 5xx) are retryable; deterministic client
 * errors (400/401/403/404…) are not. Reads both a numeric `status`/`code` (as
 * SDKs expose) and the error message text (as our hand-rolled fetch errors
 * carry it).
 */
export function isRetryableError(err: unknown): boolean {
  const anyErr = err as {
    status?: number;
    statusCode?: number;
    code?: string;
    cause?: { code?: string };
  } | null;

  const status =
    typeof anyErr?.status === "number"
      ? anyErr.status
      : typeof anyErr?.statusCode === "number"
        ? anyErr.statusCode
        : undefined;
  if (status !== undefined) {
    if (status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }

  // Node network error codes, on the error or its `cause` (undici wraps them).
  const netCode = anyErr?.code ?? anyErr?.cause?.code;
  if (
    typeof netCode === "string" &&
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/i.test(netCode)
  ) {
    return true;
  }

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    /econnreset|terminated|fetch failed|socket hang up|connection error|network|timed out|timeout|eai_again|enotfound/.test(
      msg
    )
  ) {
    return true;
  }

  // A status code embedded in a thrown message ("... API error 429: ...").
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  if (m) {
    const code = Number(m[1]);
    return code === 429 || code >= 500;
  }

  // Unknown shape — be optimistic and let the attempt budget bound it.
  return true;
}

export interface RetryOptions {
  /** Retries AFTER the first attempt. Total attempts = retries + 1. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Label for log lines. */
  label?: string;
  /** Override the retryable classifier (e.g. to exclude a hard timeout). */
  isRetryable?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 2000,
    maxDelayMs = 30_000,
    label = "LLM call",
    isRetryable = isRetryableError,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === retries || !isRetryable(err)) {
        if (attempt > 0) {
          console.warn(
            `[retry] ${label} gave up after ${attempt + 1} attempt(s): ${message}`
          );
        }
        throw err;
      }
      // Exponential backoff with full jitter, capped.
      const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.round(capped * (0.5 + Math.random() / 2));
      console.warn(
        `[retry] ${label} failed (${message}) — attempt ${attempt + 1}/${retries + 1}, retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}
