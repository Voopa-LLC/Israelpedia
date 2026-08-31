// app/admin/topics/actions.ts
"use server";

import { db } from "@/db";
import { pipelineControl, topics } from "@/db/schema";
import { requireAdmin } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";

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

  // Land on the Pending view, at the list itself.
  //
  // The view, because new topics are pending and the default view deliberately
  // excludes that bucket — otherwise you'd be told "Added 12 topics" while
  // looking at a table that doesn't contain them. The `#queue` fragment,
  // because the confirmation and the newly added rows are both down there, and
  // being returned to the top of the page means scrolling past the header and
  // the form every single time.
  if (submitted.length === 0) redirect("/admin/topics?status=pending&added=0#queue");

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
      `&skipped=${submitted.length - inserted.length}#queue`
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
 *
 * revalidatePath and NOT redirect, unlike addTopics. A redirect is a navigation:
 * it would throw away whichever search, filter and page the admin was looking
 * at, and send them back to the top. Re-validating re-renders the page where it
 * stands — the control panel updates in place, and the reader does not move.
 */
export async function setPipelineEnabled(formData: FormData) {
  const session = await requireAdmin();
  // `updated_by` is nullable, so no cast is needed here — the column simply
  // records who flipped the switch when that is known.
  const userId = session.user?.id ?? null;
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

/**
 * Move a topic to the front of the queue.
 *
 * Re-typing an existing topic into the Add box does NOT do this: that insert
 * ends in `onConflictDoNothing`, so a duplicate is rejected outright and the
 * existing row keeps whatever priority it already had. Promoting has to be an
 * update, which is what this is.
 *
 * `max(priority) + 1` — the same expression `addTopics` uses, so a promoted
 * topic lands exactly where a freshly added one would. One above the maximum
 * rather than equal to it because `claimNextTopic` breaks a priority tie on
 * `created_at`, and an old topic that merely matched the current top priority
 * would still sort behind the newer rows sharing it. It has to beat them
 * outright.
 *
 * Restricted to `pending` in the WHERE clause, not just in the UI. The button
 * only renders for pending rows, but a run can claim a topic between the render
 * and the click; promoting something already being written would raise its
 * priority for no reason, and re-order the queue behind the admin's back.
 */
export async function promoteTopic(formData: FormData) {
  await requireAdmin();
  const id = topicId(formData);

  // The subquery reads the table this statement updates. That is safe: it runs
  // against the snapshot taken when the statement began, so it cannot see its
  // own write.
  const [promoted] = await db
    .update(topics)
    .set({
      priority: sql`(select coalesce(max(${topics.priority}), 0) + 1 from ${topics})`,
      updatedAt: new Date(),
    })
    .where(and(eq(topics.id, id), eq(topics.status, "pending")))
    .returning({ topic: topics.topic });

  /**
   * A redirect here, unlike the other row actions.
   *
   * Those three change a row in place, so re-validating leaves the admin
   * looking at the result. This one changes the row's POSITION: it jumps to the
   * front of the pending list and therefore off whatever page it was on. Simply
   * re-rendering would make the row silently vanish with nothing to explain it.
   *
   * So: back to the first page, carrying the search that was used to find the
   * topic, with a banner naming what moved. `status` is not carried over —
   * the topic is pending by definition, and the pending view is where it can
   * actually be seen at the front.
   */
  const back = new URLSearchParams({ status: "pending" });
  const q = String(formData.get("q") ?? "").trim();
  if (q) back.set("q", q);
  if (promoted) back.set("promoted", promoted.topic.slice(0, 120));

  redirect(`/admin/topics?${back.toString()}#queue`);
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
