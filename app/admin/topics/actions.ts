// app/admin/topics/actions.ts
"use server";

import { db } from "@/db";
import { topics } from "@/db/schema";
import { requireAdmin } from "@/lib/auth-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

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

  if (values.length === 0) redirect("/admin/topics?added=0");

  const inserted = await db
    .insert(topics)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: topics.id });

  redirect(`/admin/topics?added=${inserted.length}&skipped=${values.length - inserted.length}`);
}

/** Put a finished/failed topic back in the queue for another run. */
export async function retryTopic(id: string, _formData: FormData) {
  await requireAdmin();
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
export async function skipTopic(id: string, _formData: FormData) {
  await requireAdmin();
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
export async function deleteTopic(id: string, _formData: FormData) {
  await requireAdmin();
  await db.delete(topics).where(eq(topics.id, id));
  revalidatePath("/admin/topics");
}
