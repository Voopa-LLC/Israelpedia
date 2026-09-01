// components/google-auth-button.tsx
import { signIn } from "@/auth";

/**
 * The only way into the site. Google is both sign-in and sign-up: OAuth creates
 * the user row on first use, so /signin and /register differ in wording only.
 * Rendered as a server component so the sign-in call stays on the server.
 */
export default function GoogleAuthButton({
  label,
  redirectTo = "/",
}: {
  label: string;
  redirectTo?: string;
}) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("google", { redirectTo });
      }}
    >
      <button type="submit" className="au-google">
        {/* Google's mark keeps its own colours in both themes, per their
            branding guidance; only the button surface follows the site. */}
        <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
          <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.4 46 24 46z" />
          <path fill="#FBBC05" d="M11.8 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.5C3 17 2.2 20.4 2.2 24s.8 7 2.3 9.9l7.3-5.7z" />
          <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8.1 6.9 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
        </svg>
        {label}
      </button>
    </form>
  );
}
