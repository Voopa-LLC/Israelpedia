## Citation and QA System — Requirements

The underlying research is generally sound; this isn't a sourcing-density problem. Citations aren't expected to substantiate every word, transition, or reasonable interpretation — only the material factual claim they're attached to. The recurring failure is **synchronization**: the system loses the correct relationship between a factual claim, its footnote marker, its bibliography entry, and its hyperlink — and separately, the QA report doesn't always accurately reflect which of those citations actually got fixed.

### 1. Preserve the claim-to-source mapping

Every footnote must resolve to a source that supports the principal factual claim immediately preceding it — not just a source that supports the claim somewhere else in the bibliography. When a claim is moved, rewritten, merged, or removed during QA, its citation must move (or be removed) with it. After editing, rebuild citation numbers from the final article as published; don't inherit them mechanically from the draft.

### 2. Don't report citation fixes that weren't made

The QA report must match what's actually in the final article. A correction only counts as applied if every relevant element changed together: the source cited, the footnote marker, the reference number, the source title, the hyperlink, and the bibliography entry.

Example of the failure mode: in the King David piece, the QA report claimed several government, archaeological, and burial citations had been replaced — but the original sources and footnotes were still there, unchanged. Run a check after QA that compares the article's footnotes, bibliography, and hyperlinks against the QA report's claims, and confirms every citation correction it describes is actually visible.

### 3. Allow reasonable interpretation, flag new claims

Sources don't need to use the article's exact wording. Calling a documented event a "turning point," describing documented methods as an "early proof of concept," or drawing a restrained conclusion from several sourced facts is fine — "This was an important turning point" needs no more than the underlying facts to support it. "This conclusively proved the theory and is accepted by all scholars" needs direct evidence for both the certainty and the consensus claim.

Flag interpretation only when it introduces a new factual proposition, exaggerates the evidence, or makes a categorical claim about causation, priority, exclusivity, or consensus — e.g., a source that documents the City of David burial being used to authenticate the separate, later Mount Zion tomb tradition.

### 4. Classify every citation; review facts more strictly than framing

Use six outcomes, not a binary pass/fail:

- **Supported** — source substantiates the material claim.
- **Partially supported** — supports the core fact, not an added precise detail (date, number, attribution, quote).
- **Mismatched** — footnote points to the wrong source.
- **Not independently verified** — link couldn't be opened or checked.
- **Source upgrade recommended** — claim is supported, but a stronger or more primary source would be preferable.
- **Outdated** — source was accurate when published; newer data exists now.

Apply the strictest review to dates, numbers, names, locations, quotations, chronology, archaeological dating, attribution, and consensus claims. A 403 is a link-access problem, not evidence the source contradicts the article — never auto-classify an inaccessible link as false. Source correspondence (does it support the claim) and source quality (is it the best available source) are separate questions; a reliable secondary source can adequately support a claim even where a primary source would be preferable.

### 5. Deduplicate and standardize references

One bibliography number per source, even when it's cited repeatedly. Normalize URLs before comparing — accounting for HTTP vs. HTTPS, tracking parameters, fragments, line wrapping, redirects, archived vs. current versions, and alternate domains hosting the same document. Different pages or sections of the same PDF (or named sections of the same page) are the same source — track the page/section as citation metadata, not as a separate bibliography entry. Duplicate entries make the bibliography misleadingly long and can imply independent corroboration that doesn't exist.

Each bibliography entry needs: publisher, the source's actual title (not a label describing one section of it), canonical URL, and access date.

### 6. Validate hyperlinks — separately from validating claims

Before export: strip soft hyphens and invisible characters, rejoin URLs broken across lines, confirm the embedded link matches the displayed URL, follow redirects, and confirm the link lands on the actual cited article or document — not a homepage or error page. Confirm sources marked "replaced" during QA are actually gone from the bibliography, not just superseded in the text.

Keep this conceptually separate from claim substantiation: a working link doesn't mean the claim is supported, and a broken one doesn't mean it's false. Report the two independently.

### 7. Match source type to claim type

Distinguish: what a biblical or primary text says; what a tradition (Jewish, Christian, or otherwise) holds; historical or archaeological evidence; a scholarly interpretation; an institutional description; a disputed or individual theory; and a claim of scholarly consensus. Attribute accordingly — "according to the biblical account," "tradition holds," "one archaeological interpretation argues," "the author proposes."

A library catalog entry can confirm an author holds a theory; it can't by itself establish whether that theory is mainstream or fringe. A religious source can substantiate what a tradition teaches without proving the claim archaeologically.

### 8. Prioritize by severity

- **Critical** — the source contradicts the claim; a quotation is fabricated or materially altered; a major factual allegation has no evidentiary basis; a hyperlink leads to an unrelated source.
- **Substantive correction** — a wrong date, number, attribution, chronology, or other precise factual detail; a compound claim hides an unsupported fact; a disputed interpretation presented as settled; a materially outdated statistic.
- **Citation-management** — right source, wrong footnote; a citation detached during editing; duplicate bibliography entries; a malformed title or hyperlink; a claimed QA fix that wasn't actually applied.
- **Editorial/cosmetic** — repetitive citations, formatting inconsistencies, minor spacing, interpretation that's reasonable but not verbatim in the source.

Borderline cases: a **mismatch** stays Citation-management if the attached source simply fails to support the claim, but escalates to **Critical** if it actively contradicts the claim. **Not independently verified** and **source upgrade recommended** default to Citation-management or Editorial severity — inaccessibility and sourcing quality aren't evidence of falsehood, and shouldn't be triaged as if they were.

### Final validation, in order

1. Extract every footnote with its surrounding claim; confirm each has a matching bibliography entry and resolves to the intended source.
2. Apply strict review to precise factual details; allow reasonable interpretive language.
3. Deduplicate and renumber references; confirm sources marked as replaced don't remain anywhere in the article or bibliography.
4. Normalize and test every hyperlink.
5. Confirm every citation correction the QA report claims was made is actually present in the article, footnote, and bibliography — and that reported source counts match the real output.
6. Confirm inaccessible sources are labeled unverified, not false.
7. Report remaining issues by severity.

### Bottom line

Don't add citation density. Keep the connection between each material claim, its footnote, its hyperlink, and its bibliography entry intact through every edit — and make sure the QA report only claims citation fixes that actually happened.
