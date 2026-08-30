/**
 * Apply db/migrations/0003_pipeline_control.sql to the database.
 *
 * Creates the AI pipeline's on/off switch and seeds it in the OFF position.
 * The SQL is additive and idempotent, so this is safe to re-run — re-running it
 * will not restart a pipeline someone has since turned on.
 *
 *   npm run db:migrate-pipeline
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import postgres from "postgres";

const FILE = path.join(__dirname, "migrations", "0003_pipeline_control.sql");

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
    WHERE table_schema = 'public' AND table_name = 'pipeline_control'
  `;
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pipeline_control'
  `;
  const [constraint] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.table_constraints
    WHERE table_name = 'pipeline_control'
      AND constraint_name = 'pipeline_control_single_row'
  `;
  const rows = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM pipeline_control
  `;

  const expected = [
    "id", "enabled", "updated_at", "updated_by",
    "worker_state", "worker_note", "worker_topic", "worker_seen_at",
  ];
  const found = new Set(columns.map((c) => c.column_name));
  const missing = expected.filter((c) => !found.has(c));

  console.log("\nVerification:");
  console.log(`  pipeline_control table    ${table.n === 1 ? "✓" : "✗ MISSING"}`);
  console.log(
    `  columns (${expected.length - missing.length}/${expected.length})              ` +
      (missing.length === 0 ? "✓" : `✗ missing: ${missing.join(", ")}`)
  );
  console.log(`  single-row constraint     ${constraint.n === 1 ? "✓" : "✗ MISSING"}`);
  console.log(
    `  the one row               ${rows.length === 1 ? `✓ (pipeline is ${rows[0].enabled ? "ON" : "OFF"})` : `✗ found ${rows.length} rows`}`
  );

  const ok =
    table.n === 1 && missing.length === 0 && constraint.n === 1 && rows.length === 1;
  console.log(
    ok
      ? "\nDone — start and stop the pipeline at /admin/topics."
      : "\nSomething is missing; see above."
  );

  await sql.end();
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message ?? err);
  process.exit(1);
});
