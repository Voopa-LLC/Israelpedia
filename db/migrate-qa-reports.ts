/**
 * Apply db/migrations/0002_article_qa_reports.sql to the database.
 *
 * Same plain runner as db/migrate-topics.ts, for the same reason: `drizzle-kit
 * push` exits silently while introspecting this database. The SQL is additive
 * and idempotent, so this is safe to re-run.
 *
 *   npm run db:migrate-qa-reports
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import postgres from "postgres";

const FILE = path.join(__dirname, "migrations", "0002_article_qa_reports.sql");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — check your .env file.");
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

  console.log("Connecting…");
  const [{ now }] = await sql<{ now: Date }[]>`SELECT now()`;
  console.log(`  ✓ connected (server time ${now.toISOString()})`);

  console.log(`Applying ${path.basename(FILE)}…`);
  await sql.unsafe(fs.readFileSync(FILE, "utf8"));
  console.log("  ✓ applied");

  // ── Verify, rather than trust ─────────────────────────────────────────────
  const [table] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'article_qa_reports'
  `;
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'article_qa_reports'
  `;
  const [fks] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.table_constraints
    WHERE table_name = 'article_qa_reports' AND constraint_type = 'FOREIGN KEY'
  `;
  const [idx] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_indexes
    WHERE tablename = 'article_qa_reports' AND indexname = 'article_qa_reports_article_idx'
  `;

  const expected = [
    "id", "article_id", "topic_id", "verdict", "reject_target", "confidence",
    "summary", "changes", "issues", "change_count", "issue_count",
    "research_variant", "saved_status", "created_at",
  ];
  const found = new Set(columns.map((c) => c.column_name));
  const missing = expected.filter((c) => !found.has(c));

  console.log("\nVerification:");
  console.log(`  article_qa_reports table   ${table.n === 1 ? "✓" : "✗ MISSING"}`);
  console.log(
    `  columns (${expected.length - missing.length}/${expected.length})             ` +
      (missing.length === 0 ? "✓" : `✗ missing: ${missing.join(", ")}`)
  );
  console.log(`  foreign keys (${fks.n}/2)          ${fks.n === 2 ? "✓" : "✗ MISSING"}`);
  console.log(`  article index              ${idx.n === 1 ? "✓" : "✗ MISSING"}`);

  const ok = table.n === 1 && missing.length === 0 && fks.n === 2 && idx.n === 1;
  console.log(ok ? "\nDone — QA reports can now be stored." : "\nSomething is missing; see above.");

  await sql.end();
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message ?? err);
  process.exit(1);
});
