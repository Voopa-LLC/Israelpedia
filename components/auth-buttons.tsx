// components/auth-buttons.tsx
import { auth, signOut } from "@/auth";
import Link from "next/link";

export default async function AuthButtons() {
  let session = null;
  try {
    session = await auth();
  } catch {}

  if (session?.user) {
    const label = session.user.name ?? session.user.email ?? "Account";
    return (
      <div className="flex items-center gap-3">
        <span
          className="hidden lg:inline text-sm text-muted max-w-[14ch] truncate"
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
          <button type="submit" className="btn btn-secondary">
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link href="/signin" className="btn btn-secondary">
        Sign in
      </Link>
      <Link href="/register" className="btn btn-primary">
        Sign up
      </Link>
    </div>
  );
}
