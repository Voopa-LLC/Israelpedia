/**
 * WrittenArticle → the shape the database and the site actually store.
 *
 * The agents produce structured JSON (sections[], references[], `[^n]` markers);
 * `articles.body` is a single Markdown column rendered by
 * components/article-markdown.tsx (react-markdown + remark-gfm). This module is
 * the one place that bridges the two, so changing the citation style later
 * means editing one function.
 *
 * Citation style: `[^7]` becomes `[[7]](https://source…)` — which renders as a
 * clickable "[7]" in the prose, matching the numbered References list the
 * article page builds from `article_references.ordinal`. GFM footnotes were the
 * alternative, but they would render a second citation list underneath the one
 * the page already renders from the database.
 */
import type { WrittenArticle } from "../agents/writing";

export interface RenderedReference {
  ordinal: number;
  sourceName: string;
  url: string;
  accessedAt: Date | null;
}

export interface RenderedArticle {
  title: string;
  /** Plain text (no Markdown, no citation markers) — the page renders it as a paragraph. */
  summary: string;
  /** Markdown: `## Heading` sections, citation markers linked to their source. */
  body: string;
  references: RenderedReference[];
  /** Non-fatal problems worth surfacing to the reviewer. */
  warnings: string[];
}

const MARKER = /\[\^(\d+)\]/g;

/** Same URL modulo the noise that shouldn't create a duplicate reference. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

function parseAccessedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip inline Markdown and citation markers — `summary` is rendered as plain text. */
function toPlainText(markdown: string): string {
  return markdown
    .replace(MARKER, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1") // inline links → their text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderArticle(article: WrittenArticle): RenderedArticle {
  const warnings: string[] = [];

  // ── References: deduplicate by URL, keeping first-appearance order ─────────
  // The Writing Agent numbers by first appearance, but the same source can be
  // listed more than once. Collapse those and remember how the old numbers map
  // onto the new ones so the body markers stay correct.
  const byUrl = new Map<string, RenderedReference>();
  const remap = new Map<number, number>();

  article.references.forEach((ref, i) => {
    const oldNumber = i + 1;
    const url = (ref.source_url ?? "").trim();
    if (!url) {
      warnings.push(`Reference ${oldNumber} ("${ref.source_name}") has no URL and was dropped.`);
      return;
    }
    const key = normalizeUrl(url);
    const existing = byUrl.get(key);
    if (existing) {
      remap.set(oldNumber, existing.ordinal);
      return;
    }
    const entry: RenderedReference = {
      ordinal: byUrl.size + 1,
      sourceName: ref.source_name?.trim() || url,
      url,
      accessedAt: parseAccessedAt(ref.accessed_date),
    };
    byUrl.set(key, entry);
    remap.set(oldNumber, entry.ordinal);
  });

  const references = [...byUrl.values()];
  const urlFor = new Map(references.map((r) => [r.ordinal, r.url]));

  const dropped = article.references.length - references.length;
  if (dropped > 0) {
    warnings.push(`Merged ${dropped} duplicate reference(s); footnote numbers were renumbered.`);
  }

  // ── Body: link every citation marker to its source ────────────────────────
  const danglingMarkers = new Set<number>();
  const linkMarkers = (text: string): string =>
    text.replace(MARKER, (_match, digits: string) => {
      const ordinal = remap.get(Number(digits));
      const url = ordinal ? urlFor.get(ordinal) : undefined;
      if (!ordinal || !url) {
        // A marker pointing at a reference that doesn't exist. Drop it rather
        // than leave a broken "[^12]" in the published prose.
        danglingMarkers.add(Number(digits));
        return "";
      }
      return `[[${ordinal}]](${url})`;
    });

  const parts: string[] = [];
  for (const section of article.sections) {
    const heading = section.heading?.trim();
    const content = linkMarkers(section.content ?? "").trim();
    if (!heading && !content) continue;
    if (heading) parts.push(`## ${heading}`);
    if (content) parts.push(content);
  }

  if (article.see_also?.length) {
    parts.push("## See also");
    parts.push(article.see_also.map((item) => `- ${item}`).join("\n"));
  }

  if (danglingMarkers.size > 0) {
    warnings.push(
      `Removed citation marker(s) with no matching reference: ${[...danglingMarkers]
        .sort((a, b) => a - b)
        .map((n) => `[^${n}]`)
        .join(", ")}.`
    );
  }

  return {
    title: article.title.trim(),
    summary: toPlainText(article.summary ?? ""),
    body: parts.join("\n\n").trim(),
    references,
    warnings,
  };
}
