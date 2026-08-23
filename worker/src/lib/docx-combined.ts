/**
 * Combined pipeline review document.
 *
 * All runs accumulate in one Word file: for each topic, the Research Agent's
 * bundle, then the Writing Agent's article, then the QA Agent's review. When
 * QA edited the article, the article is shown ONCE — the original text with
 * QA's edits marked on it track-changes style: deletions in red
 * strikethrough, insertions in green underline. Below it, the QA block lists
 * the verdict, the audit log of changes, and any unresolved issues.
 *
 * The .docx format cannot be appended to in place, so the runner keeps every
 * run in a JSON log (runs-log.json) and regenerates the full document from it
 * after each topic.
 */
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type {
  DistinctiveMaterial,
  ResearchBundle,
  ResearchFact,
  TopicCategory,
} from "../agents/research";
import type { WrittenArticle } from "../agents/writing";
import type { QAChange, QAReport } from "../agents/qa";

export interface RunEntry {
  run_at: string; // ISO timestamp
  topic: string;
  category: TopicCategory;
  bundle: ResearchBundle;
  article: WrittenArticle | null;
  /** QA Agent's report for this article; null/absent when QA didn't run. */
  qa?: QAReport | null;
  /** Set when the QA Agent failed or was skipped despite an article existing. */
  qa_note?: string;
  /** Set when the Writing Agent was skipped or failed (e.g. needs human research). */
  note?: string;
}

const DELETED_COLOR = "C00000"; // red — text QA removed
const INSERTED_COLOR = "1F7A1F"; // green — text QA added

// ── Small helpers ─────────────────────────────────────────────────────────────

function metaLine(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, italics: true, size: 18, color: "666666" })],
    spacing: { after: 160 },
  });
}

function sourceLine(
  name: string,
  url: string,
  accessedDate: string,
  extra?: string
): Paragraph {
  const parts = [`Source: ${name} — ${url} (accessed ${accessedDate})`];
  if (extra) parts.push(extra);
  return metaLine(parts.join("  •  "));
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel], pageBreak = false): Paragraph {
  return new Paragraph({
    text,
    heading: level,
    pageBreakBefore: pageBreak,
    spacing: { before: 240, after: 120 },
  });
}

// ── Research bundle rendering ─────────────────────────────────────────────────

function factParagraphs(fact: ResearchFact, index: number): Paragraph[] {
  const flag = fact.controversy_flag ? "  ⚠ CONTROVERSIAL" : "";
  return [
    new Paragraph({
      children: [new TextRun({ text: `${index}. `, bold: true }), new TextRun(fact.text)],
      spacing: { before: 120 },
    }),
    sourceLine(
      fact.source_name,
      fact.source_url,
      fact.accessed_date,
      `confidence: ${fact.confidence}${flag}`
    ),
  ];
}

function distinctiveParagraphs(item: DistinctiveMaterial): Paragraph[] {
  return [
    new Paragraph({
      children: [
        new TextRun({ text: `[${item.type.toUpperCase()}] `, bold: true }),
        new TextRun(item.text),
      ],
      spacing: { before: 120 },
    }),
    sourceLine(item.source_name, item.source_url, item.accessed_date),
  ];
}

function renderResearchBundle(bundle: ResearchBundle): Paragraph[] {
  const children: Paragraph[] = [
    heading("Research Agent Output", HeadingLevel.HEADING_2),
    metaLine(
      `Status: ${bundle.status}  •  Confidence score: ${bundle.confidence_score}`
    ),
  ];

  children.push(heading(`Facts (${bundle.facts.length})`, HeadingLevel.HEADING_3));
  if (bundle.facts.length === 0) {
    children.push(new Paragraph("No facts found in approved sources."));
  } else {
    bundle.facts.forEach((fact, i) => children.push(...factParagraphs(fact, i + 1)));
  }

  children.push(
    heading(
      `Distinctive Material (${bundle.distinctive_material.length})`,
      HeadingLevel.HEADING_3
    )
  );
  if (bundle.distinctive_material.length === 0) {
    children.push(new Paragraph("None extracted."));
  } else {
    bundle.distinctive_material.forEach((item) =>
      children.push(...distinctiveParagraphs(item))
    );
  }

  children.push(
    heading(`Controversy Flags (${bundle.controversy_flags.length})`, HeadingLevel.HEADING_3)
  );
  if (bundle.controversy_flags.length === 0) {
    children.push(new Paragraph("None."));
  } else {
    bundle.controversy_flags.forEach((flag) =>
      children.push(new Paragraph({ text: flag, bullet: { level: 0 } }))
    );
  }

  children.push(heading(`Sources (${bundle.sources.length})`, HeadingLevel.HEADING_3));
  if (bundle.sources.length === 0) {
    children.push(new Paragraph("None."));
  } else {
    bundle.sources.forEach((s) =>
      children.push(
        new Paragraph({
          text: `${s.name} — ${s.url} (accessed ${s.accessed_date})`,
          bullet: { level: 0 },
        })
      )
    );
  }

  return children;
}

// ── Research-only document ────────────────────────────────────────────────────
//
// `npm run research:only` stops after the Research Agent, so this renders just
// the bundle — no article, no QA — plus the yield stats you need to judge one
// agent against the other (facts/sources per topic, and how the facts spread
// across domains and source types).

export interface ResearchRunEntry {
  run_at: string; // ISO timestamp
  topic: string;
  /** Which Research Agent produced it, e.g. "Claude (claude-sonnet-5)". */
  agent: string;
  bundle: ResearchBundle;
}

/** Fact counts per host, richest first. */
function factsByDomain(bundle: ResearchBundle): [string, number][] {
  const counts = new Map<string, number>();
  for (const f of bundle.facts) {
    let host: string;
    try {
      host = new URL(f.source_url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      host = f.source_url;
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Fact counts per editorial source_type, richest first. */
function factsBySourceType(bundle: ResearchBundle): [string, number][] {
  const counts = new Map<string, number>();
  for (const f of bundle.facts) {
    counts.set(f.source_type, (counts.get(f.source_type) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderYieldBreakdown(bundle: ResearchBundle): Paragraph[] {
  const domains = factsByDomain(bundle);
  const types = factsBySourceType(bundle);
  return [
    heading("Yield Breakdown", HeadingLevel.HEADING_3),
    metaLine(
      `${bundle.facts.length} facts  •  ${bundle.sources.length} sources  •  ` +
        `${domains.length} distinct domains  •  ` +
        `${bundle.distinctive_material.length} distinctive  •  ` +
        `${bundle.controversy_flags.length} controversy flag(s)`
    ),
    new Paragraph({
      text: `Facts by source type: ${
        types.map(([t, n]) => `${t} ${n}`).join(", ") || "none"
      }`,
      bullet: { level: 0 },
    }),
    new Paragraph({
      text: `Facts by domain: ${
        domains.map(([d, n]) => `${d} ${n}`).join(", ") || "none"
      }`,
      bullet: { level: 0 },
    }),
  ];
}

/**
 * Build the research-only review document: one summary table up front, then
 * every topic's full bundle. Regenerated from the log after each run, same as
 * the combined document.
 */
export async function buildResearchDocx(entries: ResearchRunEntry[]): Promise<Buffer> {
  const children: Paragraph[] = [
    heading("IsraelPedia — Research Agent Output", HeadingLevel.HEADING_1),
    metaLine(`${entries.length} topic(s)  •  generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`),
    heading("Summary", HeadingLevel.HEADING_2),
  ];

  for (const entry of entries) {
    const domains = factsByDomain(entry.bundle).length;
    children.push(
      new Paragraph({
        text:
          `${entry.topic} (${entry.bundle.category}) — ${entry.bundle.facts.length} facts, ` +
          `${entry.bundle.sources.length} sources, ${domains} domains, ` +
          `status=${entry.bundle.status}, tier=${entry.bundle.significance_tier}, ` +
          `confidence=${entry.bundle.confidence_score}  [${entry.agent}]`,
        bullet: { level: 0 },
      })
    );
  }

  for (const entry of entries) {
    const runDate = entry.run_at.slice(0, 16).replace("T", " ");
    children.push(
      heading(
        `${entry.topic} (${entry.bundle.category}) — ${runDate}`,
        HeadingLevel.HEADING_1,
        true // every topic starts on a new page (the summary owns page 1)
      )
    );
    children.push(metaLine(`Research Agent: ${entry.agent}`));
    children.push(metaLine(`Significance: ${entry.bundle.significance_tier}`));
    children.push(...renderYieldBreakdown(entry.bundle));
    children.push(...renderResearchBundle(entry.bundle));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Article rendering ─────────────────────────────────────────────────────────

function proseParagraphs(content: string): Paragraph[] {
  return content
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .map(
      (block) =>
        new Paragraph({ children: [new TextRun(block)], spacing: { after: 160 } })
    );
}

function renderArticle(article: WrittenArticle): Paragraph[] {
  const children: Paragraph[] = [
    heading("Article — Writing Agent", HeadingLevel.HEADING_2),
    new Paragraph({
      children: [new TextRun({ text: article.title, bold: true, size: 32 })],
      spacing: { after: 80 },
    }),
    metaLine(
      `Status: ${article.status}${article.word_count ? `  •  ~${article.word_count} words` : ""}`
    ),
  ];

  if (article.summary) {
    // The lead may legitimately be two \n\n-separated paragraphs (per spec).
    article.summary
      .split(/\n{2,}/)
      .map((block) => block.replace(/\n/g, " ").trim())
      .filter(Boolean)
      .forEach((block) =>
        children.push(
          new Paragraph({
            children: [new TextRun({ text: block, bold: true })],
            spacing: { after: 240 },
          })
        )
      );
  }

  for (const section of article.sections) {
    children.push(
      heading(section.heading, HeadingLevel.HEADING_3),
      ...proseParagraphs(section.content)
    );
  }

  if (article.see_also.length > 0) {
    children.push(heading("See Also", HeadingLevel.HEADING_3));
    for (const item of article.see_also) {
      children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
    }
  }

  children.push(heading(`References (${article.references.length})`, HeadingLevel.HEADING_3));
  if (article.references.length === 0) {
    children.push(new Paragraph("None."));
  } else {
    article.references.forEach((ref, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true }),
            new TextRun(
              `${ref.source_name} — ${ref.source_url} (accessed ${ref.accessed_date})`
            ),
          ],
          spacing: { after: 80 },
        })
      );
    });
  }

  return children;
}

// ── QA change marking (track-changes style, without Word's revision engine) ──
//
// The article is rendered ONCE: the original Writing Agent text, with each QA
// change located inside it — the removed text in red strikethrough, the
// replacement in green underline. This was chosen over Word's real
// track-changes revisions as the safer/simpler equivalent; the visual result
// for review is the same. A change whose "before" text can't be located in
// the original still always appears in the QA audit log below the article.

interface Seg {
  text: string;
  kind: "same" | "del" | "ins";
}

/**
 * Mark QA changes inside one text field. Each change is applied at the first
 * occurrence of its `before` text and consumed (so it isn't marked twice
 * across fields). Unmatched changes are left for the audit log.
 */
function applyChangesToText(
  text: string,
  changes: QAChange[],
  used: Set<QAChange>
): Seg[] {
  let segs: Seg[] = [{ text, kind: "same" }];
  for (const change of changes) {
    if (used.has(change) || !change.before) continue;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.kind !== "same") continue;
      const idx = seg.text.indexOf(change.before);
      if (idx < 0) continue;

      const parts: Seg[] = [];
      if (idx > 0) parts.push({ text: seg.text.slice(0, idx), kind: "same" });
      parts.push({ text: change.before, kind: "del" });
      if (change.after) parts.push({ text: change.after, kind: "ins" });
      const rest = seg.text.slice(idx + change.before.length);
      if (rest) parts.push({ text: rest, kind: "same" });

      segs.splice(i, 1, ...parts);
      used.add(change);
      break;
    }
  }
  return segs;
}

/** Split a segment stream into paragraph groups at \n\n boundaries. */
function segsToParagraphGroups(segs: Seg[]): Seg[][] {
  const groups: Seg[][] = [[]];
  for (const seg of segs) {
    const pieces = seg.text.split(/\n{2,}/);
    pieces.forEach((piece, i) => {
      if (i > 0) groups.push([]);
      const cleaned = piece.replace(/\n/g, " ").trim();
      if (cleaned) groups[groups.length - 1].push({ text: cleaned, kind: seg.kind });
    });
  }
  return groups.filter((g) => g.length > 0);
}

function segRuns(segs: Seg[], base: { bold?: boolean; size?: number } = {}): TextRun[] {
  return segs.map((seg) => {
    if (seg.kind === "del") {
      return new TextRun({ ...base, text: seg.text, strike: true, color: DELETED_COLOR });
    }
    if (seg.kind === "ins") {
      return new TextRun({ ...base, text: seg.text, underline: {}, color: INSERTED_COLOR });
    }
    return new TextRun({ ...base, text: seg.text });
  });
}

function sectionKey(s: { heading: string; anchor_id?: string }): string {
  return (s.anchor_id ?? "").toLowerCase() || s.heading.toLowerCase();
}

/**
 * The Writing Agent's original article with the QA Agent's edits marked on
 * it. Sections QA removed render fully struck through; sections QA drafted
 * render fully in green.
 */
function renderArticleWithQA(original: WrittenArticle, qa: QAReport): Paragraph[] {
  const edited = qa.edited_article ?? original;
  const used = new Set<QAChange>();

  const children: Paragraph[] = [
    heading("Article — Writing Agent (QA changes marked)", HeadingLevel.HEADING_2),
    metaLine(
      "Red strikethrough = removed by QA  •  Green underline = added by QA"
    ),
    new Paragraph({
      children: segRuns(applyChangesToText(original.title, qa.changes, used), {
        bold: true,
        size: 32,
      }),
      spacing: { after: 80 },
    }),
    metaLine(
      `Status after QA: ${edited.status}${edited.word_count ? `  •  ~${edited.word_count} words` : ""}`
    ),
  ];

  for (const group of segsToParagraphGroups(
    applyChangesToText(original.summary, qa.changes, used)
  )) {
    children.push(
      new Paragraph({ children: segRuns(group, { bold: true }), spacing: { after: 240 } })
    );
  }

  const editedKeys = new Set(edited.sections.map(sectionKey));
  const originalKeys = new Set(original.sections.map(sectionKey));

  for (const section of original.sections) {
    const removed = !editedKeys.has(sectionKey(section));

    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: removed
          ? [new TextRun({ text: section.heading, strike: true, color: DELETED_COLOR })]
          : segRuns(applyChangesToText(section.heading, qa.changes, used)),
        spacing: { before: 240, after: 120 },
      })
    );
    if (removed) {
      children.push(metaLine("Section removed by QA — see the change log below."));
      for (const group of segsToParagraphGroups([{ text: section.content, kind: "del" }])) {
        children.push(new Paragraph({ children: segRuns(group), spacing: { after: 160 } }));
      }
      continue;
    }
    for (const group of segsToParagraphGroups(
      applyChangesToText(section.content, qa.changes, used)
    )) {
      children.push(new Paragraph({ children: segRuns(group), spacing: { after: 160 } }));
    }
  }

  // Sections that exist only in the edited article — drafted by QA.
  for (const section of edited.sections) {
    if (originalKeys.has(sectionKey(section))) continue;
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: section.heading, underline: {}, color: INSERTED_COLOR })],
        spacing: { before: 240, after: 120 },
      }),
      metaLine("Section drafted by QA from unused bundle material.")
    );
    for (const group of segsToParagraphGroups([{ text: section.content, kind: "ins" }])) {
      children.push(new Paragraph({ children: segRuns(group), spacing: { after: 160 } }));
    }
  }

  if (edited.see_also.length > 0) {
    children.push(heading("See Also", HeadingLevel.HEADING_3));
    for (const item of edited.see_also) {
      children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
    }
  }

  children.push(heading(`References (${edited.references.length})`, HeadingLevel.HEADING_3));
  if (edited.references.length === 0) {
    children.push(new Paragraph("None."));
  } else {
    children.push(metaLine("Numbering matches the [^n] markers of the corrected article."));
    edited.references.forEach((ref, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true }),
            new TextRun(
              `${ref.source_name} — ${ref.source_url} (accessed ${ref.accessed_date})`
            ),
          ],
          spacing: { after: 80 },
        })
      );
    });
  }

  return children;
}

/** The QA verdict block: verdict, summary, audit log of changes, open issues. */
function renderQAReport(qa: QAReport): Paragraph[] {
  const verdictLine =
    `Verdict: ${qa.verdict.toUpperCase()}` +
    (qa.reject_target ? ` → back to ${qa.reject_target}` : "") +
    `  •  Confidence: ${qa.confidence}`;

  const children: Paragraph[] = [
    heading("QA Agent Review", HeadingLevel.HEADING_2),
    new Paragraph({
      children: [
        new TextRun({
          text: verdictLine,
          bold: true,
          color: qa.verdict === "reject" ? DELETED_COLOR : undefined,
        }),
      ],
      spacing: { after: 120 },
    }),
    new Paragraph({ children: [new TextRun(qa.summary)], spacing: { after: 240 } }),
  ];

  if (qa.verdict === "reject") {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "Article rejected — no corrected version was produced. It routes back to the " +
              `${qa.reject_target ?? "writing_agent"} for regeneration.`,
            bold: true,
            color: DELETED_COLOR,
          }),
        ],
        spacing: { after: 240 },
      })
    );
  }

  children.push(heading(`Changes applied by QA (${qa.changes.length})`, HeadingLevel.HEADING_3));
  if (qa.changes.length === 0) {
    children.push(new Paragraph("None — the article was not modified."));
  } else {
    qa.changes.forEach((change, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${i + 1}. ${change.change_type}`, bold: true }),
            new TextRun(change.section ? ` — ${change.section}` : ""),
          ],
          spacing: { before: 160 },
        })
      );
      if (change.before) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "− ", bold: true, color: DELETED_COLOR }),
              new TextRun({ text: change.before, strike: true, color: DELETED_COLOR }),
            ],
          })
        );
      }
      if (change.after) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "+ ", bold: true, color: INSERTED_COLOR }),
              new TextRun({ text: change.after, color: INSERTED_COLOR }),
            ],
          })
        );
      }
      if (change.reason) children.push(metaLine(`Reason: ${change.reason}`));
    });
  }

  children.push(heading(`Unresolved issues (${qa.issues.length})`, HeadingLevel.HEADING_3));
  if (qa.issues.length === 0) {
    children.push(new Paragraph("None."));
  } else {
    for (const issue of qa.issues) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[${issue.severity.toUpperCase()}] ${issue.type}`,
              bold: true,
              color: issue.severity === "high" ? DELETED_COLOR : undefined,
            }),
            new TextRun(
              `${issue.section ? ` — ${issue.section}` : ""}: ${issue.description}`
            ),
          ],
          bullet: { level: 0 },
        })
      );
    }
  }

  return children;
}

// ── Combined document ─────────────────────────────────────────────────────────

export async function buildCombinedDocx(entries: RunEntry[]): Promise<Buffer> {
  const children: Paragraph[] = [];

  entries.forEach((entry, i) => {
    const runDate = entry.run_at.slice(0, 16).replace("T", " ");
    children.push(
      heading(
        `${entry.topic} (${entry.category}) — ${runDate}`,
        HeadingLevel.HEADING_1,
        i > 0 // each topic after the first starts on a new page
      )
    );

    children.push(...renderResearchBundle(entry.bundle));

    if (entry.article) {
      // With a non-reject QA report, show the article once — original text
      // with QA's edits marked on it. Otherwise show the article as written.
      if (entry.qa && entry.qa.verdict !== "reject" && entry.qa.edited_article) {
        children.push(...renderArticleWithQA(entry.article, entry.qa));
      } else {
        children.push(...renderArticle(entry.article));
      }

      if (entry.qa) {
        children.push(...renderQAReport(entry.qa));
      } else if (entry.qa_note) {
        children.push(
          heading("QA Agent Review", HeadingLevel.HEADING_2),
          new Paragraph({
            children: [
              new TextRun({ text: entry.qa_note, bold: true, color: "AA0000" }),
            ],
          })
        );
      }
    } else {
      children.push(
        heading("Article — Writing Agent", HeadingLevel.HEADING_2),
        new Paragraph({
          children: [
            new TextRun({
              text: entry.note ?? "Writing Agent was not run for this topic.",
              bold: true,
              color: "AA0000",
            }),
          ],
        })
      );
    }
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
