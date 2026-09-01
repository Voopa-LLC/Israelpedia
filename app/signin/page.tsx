import Link from "next/link";
import GoogleAuthButton from "@/components/google-auth-button";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        padding: "2rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: 400 }}>
        <h1 style={{ marginBottom: "0.25rem" }}>Sign in</h1>
        <p style={{ color: "#555", marginBottom: "2rem" }}>
          Welcome back to IsraelPedia.
        </p>

        <GoogleAuthButton label="Sign in with Google" redirectTo={callbackUrl || "/"} />

        <p style={{ marginTop: "1.5rem", textAlign: "center", color: "#555", fontSize: "0.9rem" }}>
          Don&apos;t have an account?{" "}
          <Link href="/register" style={{ color: "#0070f3" }}>
            Sign up
          </Link>
        </p>
        <p style={{ textAlign: "center", marginTop: "0.5rem" }}>
          <Link href="/" style={{ color: "#aaa", fontSize: "0.85rem" }}>
            ← Back to IsraelPedia
          </Link>
        </p>
      </div>
    </main>
  );
}
