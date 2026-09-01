import Link from "next/link";
import GoogleAuthButton from "@/components/google-auth-button";

export default async function RegisterPage({
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
        <h1 style={{ marginBottom: "0.25rem" }}>Create an account</h1>
        <p style={{ color: "#555", marginBottom: "2rem" }}>
          Join IsraelPedia to suggest article topics.
        </p>

        <GoogleAuthButton label="Sign up with Google" redirectTo={callbackUrl || "/"} />

        <p style={{ marginTop: "1.5rem", textAlign: "center", color: "#555", fontSize: "0.9rem" }}>
          Already have an account?{" "}
          <Link href="/signin" style={{ color: "#0070f3" }}>
            Sign in
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
