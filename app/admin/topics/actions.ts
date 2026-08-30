// app/admin/topics/actions.ts
"use server";

import { db } from "@/db";
import { pipelineControl, topics } from "@/db/schema";
import { requireAdmin } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The topic a row action was submitted for.
 *
 * The id arrives as a hidden form field rather than a bound argument
 * (`retryTopic.bind(null, id)`). Next.js serialises every bound argument with a
 * full React Flight render plus AES-GCM encryption — see
 * `next/dist/server/app-render/encryption.js` — and the `React.cache` around it
 * is keyed on the argument, so a distinct id per row means a cache miss every
 * time. A page of N rows paid for N of those; with thousands of topics queued
 * it was the single biggest cost of rendering this page.
 *
 * Passing it as form data means one shared action reference for every row and
 * no per-row serialisation. The value now comes from the client, so it is
 * validated here — it grants nothing `requireAdmin()` doesn't already grant
 * (an admin may act on any topic), but a malformed value must not reach a query.
 */
function topicId(formData: FormData): string {
  const id = String(formData.get("id") ?? "");
  if (!UUID.test(id)) throw new Error("Invalid topic id.");
  return id;
}

/**
 * Add topics to the AI pipeline's queue — one per line, blank lines and
 * `#` comments ignored. Duplicates (case-insensitive, against the unique index
 * on lower(topic)) are silently skipped, so pasting an overlapping list again
 * is safe.
 *
 * Topics added here go to the FRONT of the queue.
 *
 * A run claims by `priority DESC, created_at ASC` (see claimNextTopic), so a
 * new topic at the default priority sorts behind every one of the thousands
 * already waiting — added today, written months from now. The reason to type a
 * topic in by hand is that you want it written, so each batch is inserted one
 * step above the highest priority the table currently holds, which puts it next
 * in line whatever else is queued.
 */
export async function addTopics(formData: FormData) {
  const session = await requireAdmin();
  const userId = (session.user as any).id as string;

  const raw = (formData.get("topics") as string) ?? "";

  const seen = new Set<string>();
  const submitted = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Land on the Pending view: new topics are pending, and the default view
  // deliberately excludes that bucket, so otherwise you'd be told "Added 12
  // topics" while looking at a table that doesn't contain them.
  if (submitted.length === 0) redirect("/admin/topics?status=pending&added=0");

  /**
   * One above the current maximum, evaluated INSIDE the insert rather than as a
   * separate read. That keeps the whole add to a single statement against a
   * single snapshot: every row in the batch lands on the same priority, and a
   * concurrent add cannot slot itself in between a read and a write.
   */
  const frontOfQueue = sql<number>`(select coalesce(max(${topics.priority}), 0) + 1 from ${topics})`;

  const inserted = await db
    .insert(topics)
    .values(submitted.map((topic) => ({ topic, priority: frontOfQueue, addedBy: userId })))
    .onConflictDoNothing()
    .returning({ id: topics.id });

  redirect(
    `/admin/topics?status=pending&added=${inserted.length}` +
      `&skipped=${submitted.length - inserted.length}`
  );
}

/**
 * Start or stop the AI pipeline.
 *
 * The pipeline is a separate service on another host; nothing here can reach
 * it. What this writes is the row it polls every few seconds (see
 * worker/src/lib/pipeline-control.ts), so expect a short delay before the
 * change takes hold — and check the panel, which reports what the worker is
 * actually doing rather than what was asked of it.
 *
 * STOP MEANS "CLAIM NOTHING MORE", not "abandon what you are doing". A topic
 * already being written is finished and published first: killing it mid-run
 * would throw away research that has already been paid for, and leave the row
 * marked `running` for the stale-topic sweep to find.
 *
 * The upsert is deliberate. The row is normally created by
 * db/migrations/0003_pipeline_control.sql; if that has not been run, an admin
 * pressing Start should create the switch rather than hit an error.
 */
export async function setPipelineEnabled(formData: FormData) {
  const session = await requireAdmin();
  const userId = (session.user as any).id as string;
  const enabled = formData.get("enabled") === "true";

  // `now()` rather than a JS Date: the panel reports these as "3 minutes ago"
  // by subtracting in SQL, so the stamp has to come from the same clock.
  await db
    .insert(pipelineControl)
    .values({ id: true, enabled, updatedAt: sql`now()`, updatedBy: userId })
    .onConflictDoUpdate({
      target: pipelineControl.id,
      set: { enabled, updatedAt: sql`now()`, updatedBy: userId },
    });

  revalidatePath("/admin/topics");
}

/** Put a finished/failed topic back in the queue for another run. */
export async function retryTopic(formData: FormData) {
  await requireAdmin();
  const id = topicId(formData);
  await db
    .update(topics)
    .set({
      status: "pending",
      lastError: null,
      note: null,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(topics.id, id));
  revalidatePath("/admin/topics");
}

/** Park a topic so no run ever claims it. */
export async function skipTopic(formData: FormData) {
  await requireAdmin();
  const id = topicId(formData);
  await db
    .update(topics)
    .set({ status: "skipped", updatedAt: new Date() })
    .where(eq(topics.id, id));
  revalidatePath("/admin/topics");
}

/**
 * Remove a topic from the queue entirely. Any article it produced is left
 * alone — `topics.article_id` is ON DELETE SET NULL in the other direction, and
 * deleting the queue row never touches `articles`.
 */
export async function deleteTopic(formData: FormData) {
  await requireAdmin();
  const id = topicId(formData);
  await db.delete(topics).where(eq(topics.id, id));
  revalidatePath("/admin/topics");
}
