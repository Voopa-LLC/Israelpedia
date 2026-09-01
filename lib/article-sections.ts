/**
 * Splits an article body into the numbered sections the article page renders.
 *
 * Bodies are Markdown whose sections are `## ` headings (the AI pipeline emits
 * no H1 and no top-level prose). The page needs each section separately — not
 * one rendered blob — so it can give each a numbered heading, an anchor, and a
 * table-of-contents entry.
 */

export type ArticleSection = {
  /** Anchor id, used by the TOC links and the scroll-spy. */
  id: string;
  title: string;
  /** Markdown for this section, heading line excluded. */
  content: string;
};

/** "Origins and Early History" → "origins-and-early-history" */
export function slugifyHeading(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return base || "section";
}

export function splitIntoSections(body: string): {
  /** Prose appearing before the first `##`, if a body has any. */
  intro: string;
  sections: ArticleSection[];
} {
  // Some bodies lead with an H1 repeating the title; the page renders the
  // title itself, so drop it.
  const withoutTitle = body.replace(/^\s*#\s+.*(\r?\n)+/, "");

  const introLines: string[] = [];
  const sections: ArticleSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;

  for (const line of withoutTitle.split(/\r?\n/)) {
    // A "## " inside a fenced code block is code, not a heading.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const heading = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);

    if (heading) {
      if (current) {
        sections.push({
          id: slugifyHeading(current.title),
          title: current.title,
          content: current.lines.join("\n").trim(),
        });
      }
      current = { title: heading[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      introLines.push(line);
    }
  }

  if (current) {
    sections.push({
      id: slugifyHeading(current.title),
      title: current.title,
      content: current.lines.join("\n").trim(),
    });
  }

  // Two sections can slugify identically ("Legacy" twice); make ids unique so
  // the TOC links never point at the wrong place.
  const seen = new Map<string, number>();
  for (const s of sections) {
    const n = seen.get(s.id) ?? 0;
    seen.set(s.id, n + 1);
    if (n > 0) s.id = `${s.id}-${n + 1}`;
  }

  return { intro: introLines.join("\n").trim(), sections };
}

/** 1 → "01". Section numbers are two-digit in the design. */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
