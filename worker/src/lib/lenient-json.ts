/**
 * Tolerant JSON parsing for LLM responses.
 *
 * Models occasionally emit JSON with the malformations that a plain
 * JSON.parse rejects outright — most commonly an unescaped double-quote inside
 * a long string value, but also stray control characters, trailing/missing
 * commas, and output truncated mid-object. A single bad character used to throw
 * away an entire finished article; this recovers it deterministically.
 *
 * Strategy: try strict JSON.parse first (the normal path — zero cost, and a
 * well-formed response is never altered), and only fall back to jsonrepair when
 * that throws. Repair is logged so a relapse stays visible.
 */
import { jsonrepair } from "jsonrepair";

/**
 * Parse `text` as JSON, repairing common LLM malformations if strict parsing
 * fails. Throws the ORIGINAL SyntaxError (whose position points at the real
 * offending character) only when the text cannot be salvaged at all — the
 * caller decides whether to regenerate.
 */
export function parseLenientJson(text: string, label = "response"): unknown {
  try {
    return JSON.parse(text);
  } catch (strictErr) {
    try {
      const parsed = JSON.parse(jsonrepair(text));
      console.warn(`[json] ${label} was malformed JSON — repaired automatically (jsonrepair)`);
      return parsed;
    } catch {
      // jsonrepair couldn't salvage it either — surface the strict error, which
      // has the useful position info, not jsonrepair's.
      throw strictErr;
    }
  }
}
