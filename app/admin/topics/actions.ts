// app/admin/topics/actions.ts
"use server";

import { db } from "@/db";
import { topics } from "@/db/schema";
import { requireAdmin } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

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
 */
export async function addTopics(formData: FormData) {
  const session = await requireAdmin();
  const userId = (session.user as any).id as string;

  const raw = (formData.get("topics") as string) ?? "";
  const priority = Number(formData.get("priority")) || 0;

  const seen = new Set<string>();
  const values = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((topic) => ({ topic, priority, addedBy: userId }));

  // Land on the Pending view: new topics are pending, and the default view
  // deliberately excludes that bucket, so otherwise you'd be told "Added 12
  // topics" while looking at a table that doesn't contain them.
  if (values.length === 0) redirect("/admin/topics?status=pending&added=0");

  const inserted = await db
    .insert(topics)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: topics.id });

  redirect(
    `/admin/topics?status=pending&added=${inserted.length}` +
      `&skipped=${values.length - inserted.length}`
  );
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
