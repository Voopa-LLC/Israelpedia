import dotenv from "dotenv";
dotenv.config();

import cron from "node-cron";
import { runPipeline } from "./pipeline";

const SCHEDULE = "0 */6 * * *"; // 00:00, 06:00, 12:00, 18:00

// MANUAL TESTING MODE: the automated pipeline is disabled by default while the
// new research-based pipeline is built and tested. Set ENABLE_PIPELINE_CRON=true
// in the environment to re-enable scheduled (and startup) runs.
const CRON_ENABLED = process.env.ENABLE_PIPELINE_CRON === "true";

console.log("Worker started.");

if (CRON_ENABLED) {
  console.log(`Pipeline scheduled: every 6 hours (${SCHEDULE})`);

  // Run once immediately on startup, then on schedule
  runPipeline().catch((err) => console.error("[Startup] Pipeline failed:", err));

  cron.schedule(SCHEDULE, () => {
    runPipeline().catch((err) => console.error("[Cron] Pipeline failed:", err));
  });
} else {
  console.log(
    "Pipeline cron is DISABLED (manual testing mode). " +
      "Set ENABLE_PIPELINE_CRON=true to enable scheduled runs."
  );
  console.log("Run the Research Agent manually with: npm run research");
}
