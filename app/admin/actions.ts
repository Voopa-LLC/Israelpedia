// app/admin/actions.ts
"use server";

import { db } from "@/db";
import { articles, articleReferences, articleRevisions, suggestions } from "@/db/schema";
import { requireAdmin } from "@/lib/auth-guard";
import { parseCategory } from "@/lib/article-categories";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

function slugify(title: string) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function nullIfEmpty(s: string | null | undefined): string | null {
  const v = s?.trim();
  return v ? v : null;
}

export async function createArticle(formData: FormData) {
  const session = await requireAdmin();
  const userId = (session.user as any).id as string;

  const title = (formData.get("title") as string)?.trim();
  const summary = nullIfEmpty(formData.get("summary") as string);
  const body = (formData.get("body") as string)?.trim();
  const status = (formData.get("status") as string) || "draft";
  // Anything that isn't one of the four known categories becomes null rather
  // than being trusted into the column — the form is not the only way to POST.
  const category = parseCategory(formData.get("category"));

  const titleHe = nullIfEmpty(formData.get("titleHe") as string);
  const summaryHe = nullIfEmpty(formData.get("summaryHe") as string);
  const bodyHe = nullIfEmpty(formData.get("bodyHe") as string);

  if (!title || !body) throw new Error("Title and body are required.");

  const slug = slugify(title);

  const refUrls    = formData.getAll("ref_url")    as string[];
  const refTitles  = formData.getAll("ref_title")  as string[];
  const refSources = formData.getAll("ref_source") as string[];

  const newArticleId = await db.transaction(async (tx) => {
    const [article] = await tx
      .insert(articles)
      .values({
        slug,
        title,
        summary,
        body,
        titleHe,
        summaryHe,
        bodyHe,
        status: status as any,
        category,
        origin: "human",
        createdBy: userId,
        publishedAt: status === "published" ? new Date() : null,
      })
      .returning({ id: articles.id });

    await tx.insert(articleRevisions).values({
      articleId: article.id,
      title,
      summary,
      body,
      titleHe,
      summaryHe,
      bodyHe,
      editedBy: userId,
      editorNote: "Initial creation",
    });

    for (let i = 0; i < refUrls.length; i++) {
      const url      = refUrls[i]?.trim();
      const refTitle = refTitles[i]?.trim();
      const source   = refSources[i]?.trim();
      if (url || refTitle) {
        await tx.insert(articleReferences).values({
          articleId: article.id,
          url: url || null,
          title: refTitle || null,
          sourceName: source || null,
        });
      }
    }

    return article.id;
  });

  redirect(`/admin?created=${newArticleId}`);
}

export async function updateArticle(formData: FormData) {
  const session = await requireAdmin();
  const userId = (session.user as any).id as string;

  const articleId  = formData.get("articleId") as string;
  const title      = (formData.get("title") as string)?.trim();
  const summary    = nullIfEmpty(formData.get("summary") as string);
  const body       = (formData.get("body") as string)?.trim();
  const status     = (formData.get("status") as string) || "draft";
  const category   = parseCategory(formData.get("category"));
  const editorNote = nullIfEmpty(formData.get("editorNote") as string);

  const titleHe   = nullIfEmpty(formData.get("titleHe") as string);
  const summaryHe = nullIfEmpty(formData.get("summaryHe") as string);
  const bodyHe    = nullIfEmpty(formData.get("bodyHe") as string);

  if (!title || !body) throw new Error("Title and body are required.");

  const refUrls    = formData.getAll("ref_url")    as string[];
  const refTitles  = formData.getAll("ref_title")  as string[];
  const refSources = formData.getAll("ref_source") as string[];

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(articles).where(eq(articles.id, articleId));
    if (!current) throw new Error("Article not found.");

    // Snapshot the state BEFORE this edit (for the revision history).
    await tx.insert(articleRevisions).values({
      articleId,
      title:     current.title,
      summary:   current.summary,
      body:      current.body,
      titleHe:   current.titleHe,
      summaryHe: current.summaryHe,
      bodyHe:    current.bodyHe,
      editedBy:  userId,
      editorNote,
    });

    await tx.update(articles)
      .set({
        title,
        summary,
        body,
        titleHe,
        summaryHe,
        bodyHe,
        status: status as any,
        // Editable for AI articles too: this is where an admin corrects the
        // category the Research Agent picked. "— None —" clears it.
        category,
        updatedAt: new Date(),
        publishedAt:
          status === "published" && !current.publishedAt ? new Date() : current.publishedAt,
      })
      .where(eq(articles.id, articleId));

    await tx.delete(articleReferences).where(eq(articleReferences.articleId, articleId));

    for (let i = 0; i < refUrls.length; i++) {
      const url      = refUrls[i]?.trim();
      const refTitle = refTitles[i]?.trim();
      const source   = refSources[i]?.trim();
      if (url || refTitle) {
        await tx.insert(articleReferences).values({
          articleId,
          url: url || null,
          title: refTitle || null,
          sourceName: source || null,
        });
      }
    }
  });

  redirect("/admin");
}

export async function setArticleStatus(formData: FormData) {
  await requireAdmin();

  const articleId = formData.get("articleId") as string;
  const status = formData.get("status") as string;
  const valid = ["draft", "review", "published", "archived"];
  if (!articleId || !valid.includes(status)) return;

  const [current] = await db.select().from(articles).where(eq(articles.id, articleId));
  if (!current) throw new Error("Article not found.");

  await db
    .update(articles)
    .set({
      status: status as any,
      updatedAt: new Date(),
      publishedAt:
        status === "published" && !current.publishedAt ? new Date() : current.publishedAt,
    })
    .where(eq(articles.id, articleId));

  revalidatePath("/admin");
}

export async function acceptSuggestion(suggestionId: string, _formData: FormData) {
  const session = await requireAdmin();
  const userId = (session.user as any).id as string;

  const [suggestion] = await db.select().from(suggestions).where(eq(suggestions.id, suggestionId));
  if (!suggestion) throw new Error("Suggestion not found.");

  const slug = slugify(suggestion.topic);

  const newSlug = await db.transaction(async (tx) => {
    const [article] = await tx
      .insert(articles)
      .values({
        slug,
        title: suggestion.topic,
        body: "",
        status: "draft",
        origin: "user_suggestion",
        createdBy: userId,
      })
      .returning({ id: articles.id, slug: articles.slug });

    await tx
      .update(suggestions)
      .set({ status: "accepted", articleId: article.id })
      .where(eq(suggestions.id, suggestionId));

    return article.slug;
  });

  redirect(`/admin/edit/${newSlug}`);
}

export async function rejectSuggestion(suggestionId: string, formData: FormData) {
  await requireAdmin();

  const reviewNote = (formData.get("reviewNote") as string)?.trim();
  if (!reviewNote) throw new Error("A rejection reason is required.");

  await db
    .update(suggestions)
    .set({ status: "rejected", reviewNote })
    .where(eq(suggestions.id, suggestionId));
}

export async function archiveArticle(id: string, _formData: FormData) {
  await requireAdmin();
  await db.update(articles).set({ status: "archived" }).where(eq(articles.id, id));
  redirect("/admin");
}
