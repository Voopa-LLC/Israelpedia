import { requireUser } from "@/lib/auth-guard";
import Link from "next/link";
import SuggestForm from "./suggest-form";

export const metadata = { title: "Suggest a topic" };

export default async function SuggestPage() {
  await requireUser("/suggest");

  return (
    <main className="sg-page">
      <div className="sg-shell py-12 sm:py-14">
        <Link href="/" className="ap-back">
          ← All articles
        </Link>

        <p className="hp-eyebrow mt-7">Help shape the library</p>
        <h1 className="hp-heading mt-2">Suggest a topic</h1>
        <p className="sg-intro">
          Is something missing? Tell us what you’d like to see covered. An editor
          reads every suggestion, and accepted topics are researched and written
          with real, cited sources.
        </p>

        <hr className="sr-rule" />

        <div className="sg-card">
          <SuggestForm />
        </div>
      </div>
    </main>
  );
}
