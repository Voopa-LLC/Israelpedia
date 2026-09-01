import Link from "next/link";
import GoogleAuthButton from "@/components/google-auth-button";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <main className="au-page">
      <div className="au-card">
        <p className="hp-eyebrow">Welcome back</p>
        <h1 className="au-title">Sign in</h1>
        <p className="au-sub">
          Sign in to suggest topics for the library.
        </p>

        <div className="au-action">
          <GoogleAuthButton label="Sign in with Google" redirectTo={callbackUrl || "/"} />
        </div>

        <p className="au-alt">
          Don’t have an account?{" "}
          <Link href="/register" className="au-alt-link">
            Sign up
          </Link>
        </p>
      </div>

      <Link href="/" className="au-back">
        ← Back to IsraelPedia
      </Link>
    </main>
  );
}
