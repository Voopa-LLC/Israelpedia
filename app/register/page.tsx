import Link from "next/link";
import GoogleAuthButton from "@/components/google-auth-button";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <main className="au-page">
      <div className="au-card">
        <p className="hp-eyebrow">Join the library</p>
        <h1 className="au-title">Create an account</h1>
        <p className="au-sub">
          An account lets you suggest topics for the library.
        </p>

        <div className="au-action">
          <GoogleAuthButton label="Sign up with Google" redirectTo={callbackUrl || "/"} />
        </div>

        <p className="au-alt">
          Already have an account?{" "}
          <Link href="/signin" className="au-alt-link">
            Sign in
          </Link>
        </p>
      </div>

      <Link href="/" className="au-back">
        ← Back to IsraelPedia
      </Link>
    </main>
  );
}
