import { requireAdmin } from "@/lib/auth-guard";
import Link from "next/link";

export const metadata = { title: "Admin" };

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();

  return (
    <div>
      {/* Admin sub-header — visually marks this as the editorial workspace */}
      <div className="border-b border-techelet/20 bg-techelet/[0.06]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <span className="badge bg-techelet text-on-brand">Admin</span>
          <nav className="flex items-center gap-5 text-sm font-medium">
            <Link href="/admin" className="text-ink transition-colors hover:text-techelet">
              Articles
            </Link>
            <Link href="/admin/new" className="text-ink transition-colors hover:text-techelet">
              New article
            </Link>
            <Link href="/admin/topics" className="text-ink transition-colors hover:text-techelet">
              Topic queue
            </Link>
          </nav>
          <Link
            href="/"
            className="ml-auto text-sm text-muted transition-colors hover:text-techelet"
          >
            View site →
          </Link>
        </div>
      </div>
      {children}
    </div>
  );
}
