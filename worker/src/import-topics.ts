/**
 * Bulk-load topics into the `topics` queue.
 *
 * Usage (from the worker/ folder):
 *   npm run topics:import -- my-topics.txt
 *   npm run topics:import -- my-topics.csv --priority 10
 *   npm run topics:import -- my-topics.txt --dry-run
 *
 * File format — plain text, one topic per line:
 *
 *   Energy in Israel
 *   Zvi Yehuda Kook
 *   # lines starting with # are ignored, as are blank lines
 *
 * Or CSV/pipe-separated, with an optional header row, for when you want to
 * override what the Research Agent would decide for itself:
 *
 *   topic,category,significance_tier,priority
 *   Tel Aviv,place,major,10
 *   Moses,person,major,
 *
 * `category` is person|place|event|concept and `significance_tier` is
 * major|standard — both optional. Leave them empty and the Research Agent
 * classifies the topic itself, which is the normal case.
 *
 * Re-running is safe: topics already in the table are skipped (the match is
 * case-insensitive), so you can append to your file and import it again.
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { inArray, sql } from "drizzle-orm";
import { articles, topics } from "../../db/schema";
import { closeDb, getDb } from "./lib/db";

type Category = "person" | "place" | "event" | "concept";
type Tier = "major" | "standard";

const CATEGORIES: Category[] = ["person", "place", "event", "concept"];
const TIERS: Tier[] = ["major", "standard"];

interface ParsedTopic {
  topic: string;
  category?: Category;
  significanceTier?: Tier;
  priority?: number;
  /** Source line number, for error messages. */
  line: number;
}

interface Options {
  file: string;
  /** Applied to every row that doesn't set its own. */
  priority: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let priority = 0;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--priority" || arg === "-p") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value)) {
        console.error("--priority needs a whole number, e.g. `--priority 10`.");
        process.exit(1);
      }
      priority = value;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error(
      "Usage: npm run topics:import -- <file.txt|file.csv> [--priority N] [--dry-run]"
    );
    process.exit(1);
  }
  return { file: positional[0], priority, dryRun };
}

/** Split a line on comma or pipe, respecting simple double-quoted fields. */
function splitFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if ((char === "," || char === "|") && !quoted) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseFile(contents: string): { rows: ParsedTopic[]; problems: string[] } {
  const rows: ParsedTopic[] = [];
  const problems: string[] = [];
  const lines = contents.split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNumber = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;

    const fields = splitFields(line);
    const topic = fields[0];
    if (!topic) return;

    // Skip a CSV header row.
    if (lineNumber === 1 && topic.toLowerCase() === "topic") return;

    const row: ParsedTopic = { topic, line: lineNumber };

    const category = fields[1]?.toLowerCase();
    if (category) {
      if (!CATEGORIES.includes(category as Category)) {
        problems.push(`line ${lineNumber}: unknown category "${fields[1]}" — left for the agent to decide`);
      } else {
        row.category = category as Category;
      }
    }

    const tier = fields[2]?.toLowerCase();
    if (tier) {
      if (!TIERS.includes(tier as Tier)) {
        problems.push(`line ${lineNumber}: unknown significance tier "${fields[2]}" — left unset`);
      } else {
        row.significanceTier = tier as Tier;
      }
    }

    if (fields[3]) {
      const priority = Number(fields[3]);
      if (!Number.isInteger(priority)) {
        problems.push(`line ${lineNumber}: priority "${fields[3]}" is not a whole number — ignored`);
      } else {
        row.priority = priority;
      }
    }

    rows.push(row);
  });

  return { rows, problems };
}

/** Collapse duplicates inside the file itself, keeping the first occurrence. */
function dedupe(rows: ParsedTopic[]): { unique: ParsedTopic[]; duplicates: string[] } {
  const seen = new Map<string, ParsedTopic>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const key = row.topic.trim().toLowerCase();
    if (seen.has(key)) {
      duplicates.push(`line ${row.line}: "${row.topic}" appears earlier in the file`);
      continue;
    }
    seen.set(key, row);
  }
  return { unique: [...seen.values()], duplicates };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(process.cwd(), options.file);

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const { rows, problems } = parseFile(fs.readFileSync(filePath, "utf8"));
  const { unique, duplicates } = dedupe(rows);

  for (const problem of [...problems, ...duplicates]) console.warn(`[warn] ${problem}`);

  if (unique.length === 0) {
    console.log("No topics found in the file — nothing to import.");
    return;
  }

  console.log(`Parsed ${unique.length} topic(s) from ${filePath}`);

  if (options.dryRun) {
    console.log("\n--dry-run — nothing was written. These would be imported:\n");
    for (const row of unique) {
      const extras = [row.category, row.significanceTier, row.priority ? `p${row.priority}` : null]
        .filter(Boolean)
        .join(", ");
      console.log(`  • ${row.topic}${extras ? `  (${extras})` : ""}`);
    }
    return;
  }

  const db = getDb();

  // Warn (don't block) when an article with this title already exists — usually
  // a sign the topic was covered under a slightly different name.
  const existingTitles = await db
    .select({ title: articles.title })
    .from(articles)
    .where(
      inArray(
        sql`lower(${articles.title})`,
        unique.map((r) => r.topic.trim().toLowerCase())
      )
    );
  for (const row of existingTitles) {
    console.warn(`[warn] An article titled "${row.title}" already exists — importing anyway.`);
  }

  // `ON CONFLICT DO NOTHING` against the case-insensitive unique index, so
  // re-importing the same file is a no-op instead of an error.
  const inserted = await db
    .insert(topics)
    .values(
      unique.map((row) => ({
        topic: row.topic,
        category: row.category,
        significanceTier: row.significanceTier,
        priority: row.priority ?? options.priority,
      }))
    )
    .onConflictDoNothing()
    .returning({ id: topics.id, topic: topics.topic });

  const skipped = unique.length - inserted.length;
  console.log(
    `\nImported ${inserted.length} new topic(s)` +
      (skipped > 0 ? `, skipped ${skipped} already in the queue` : "") +
      "."
  );
  console.log("Run them with: npm run research");
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
