/**
 * Apply db/migrations/0001_topics_queue.sql to the database.
 *
 * A plain runner for the one migration `drizzle-kit push` could not apply
 * (it exits silently while introspecting this database). The SQL is additive
 * and idempotent, so this is safe to re-run.
 *
 *   npm run db:migrate-topics
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import postgres from "postgres";

const FILE = path.join(__dirname, "migrations", "0001_topics_queue.sql");

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
  // `sql.unsafe` with a multi-statement string runs the file as one batch, so
  // a failure part-way rolls nothing back — which is fine here because every
  // statement is individually idempotent.
  await sql.unsafe(fs.readFileSync(FILE, "utf8"));
  console.log("  ✓ applied");

  // ── Verify, rather than trust ─────────────────────────────────────────────
  const [topicsTable] = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'topics'
  `;
  const [ordinalCol] = await sql`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'article_references' AND column_name = 'ordinal'
  `;
  const enums = await sql<{ typname: string }[]>`
    SELECT typname FROM pg_type
    WHERE typname IN ('topic_status', 'topic_category', 'significance_tier')
  `;

  console.log("\nVerification:");
  console.log(`  topics table            ${topicsTable.n === 1 ? "✓" : "✗ MISSING"}`);
  console.log(`  article_references.ordinal  ${ordinalCol.n === 1 ? "✓" : "✗ MISSING"}`);
  console.log(`  enums (${enums.length}/3)             ${enums.length === 3 ? "✓" : "✗ MISSING"}`);

  const ok = topicsTable.n === 1 && ordinalCol.n === 1 && enums.length === 3;
  console.log(ok ? "\nDone — the database is ready." : "\nSomething is missing; see above.");

  await sql.end();
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message ?? err);
  process.exit(1);
});
