// components/auth-buttons.tsx
import { auth, signOut } from "@/auth";
import Link from "next/link";

/**
 * variant "default" is the site-wide header treatment and is used on every
 * page except the home page. "home" renders the same three states in the
 * home design's type and colour — see the .hp-* block in globals.css.
 */
export default async function AuthButtons({
  variant = "default",
}: {
  variant?: "default" | "home";
}) {
  let session = null;
  try {
    session = await auth();
  } catch {}

  const isHome = variant === "home";

  if (session?.user) {
    const label = session.user.name ?? session.user.email ?? "Account";
    return (
      <div className="flex items-center gap-3">
        <span
          className={
            isHome
              ? "hidden lg:inline max-w-[14ch] truncate text-[0.8125rem] font-semibold text-[var(--hp-body)]"
              : "hidden lg:inline text-sm text-muted max-w-[14ch] truncate"
          }
          title={label}
        >
          {label}
        </span>
        <form
          action={async () => {
            "use server";
            await signOut();
          }}
        >
          <button type="submit" className={isHome ? "hp-navlink" : "btn btn-secondary"}>
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={isHome ? "flex items-center gap-1" : "flex items-center gap-2"}>
      <Link href="/signin" className={isHome ? "hp-navlink" : "btn btn-secondary"}>
        Sign in
      </Link>
      <Link href="/register" className={isHome ? "hp-btn" : "btn btn-primary"}>
        Sign up
      </Link>
    </div>
  );
}
