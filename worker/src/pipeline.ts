/**
 * Pipeline orchestrator.
 *
 * The old discovery → triage → drafting pipeline has been removed. The
 * replacement — Research → Writing → QA, fed by the `topics` table — is run
 * manually during this testing phase with `npm run research` (see
 * src/run-research.ts). That path DOES write to the database: finished articles
 * are saved as origin="ai", status="review" for a human to approve in /admin.
 *
 * This function is kept so the cron scheduling in index.ts stays structurally
 * in place. Wiring it to the same queue is what turns the manual runs into
 * scheduled ones; nothing here runs while ENABLE_PIPELINE_CRON is unset.
 */
export async function runPipeline(): Promise<void> {
  console.log("\n=== Pipeline run starting ===");
  console.log(
    "[Pipeline] No automated stages are active yet. " +
      "Run the pipeline manually with `npm run research` — it takes its topics " +
      "from the `topics` table."
  );
  console.log("=== Pipeline run complete ===\n");
}
