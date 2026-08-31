"use client";

import { Suspense, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import Wordmark from "./wordmark";
import ThemeToggle from "./theme-toggle";

const SearchIcon = () => (
  <svg
    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
    width="17" height="17" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

// Inner component reads useSearchParams — must be wrapped in Suspense
function SearchFieldInner({
  className = "",
  autoFocus = false,
}: {
  className?: string;
  autoFocus?: boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const currentQuery = pathname === "/search" ? (params.get("q") ?? "") : "";

  return (
    <form action="/search" method="get" role="search" className={`relative ${className}`}>
      <SearchIcon />
      <input
        key={currentQuery}
        type="search"
        name="q"
        defaultValue={currentQuery}
        autoFocus={autoFocus}
        placeholder="Search IsraelPedia"
        aria-label="Search articles"
        className="input !pl-9"
      />
    </form>
  );
}

function SearchField({
  className = "",
  autoFocus = false,
}: {
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <form action="/search" method="get" role="search" className={`relative ${className}`}>
          <SearchIcon />
          <input
            type="search"
            name="q"
            placeholder="Search IsraelPedia"
            aria-label="Search articles"
            className="input !pl-9"
          />
        </form>
      }
    >
      <SearchFieldInner className={className} autoFocus={autoFocus} />
    </Suspense>
  );
}

export default function HeaderShell({
  isAdmin,
  authSlot,
  suggestDesktop,
  suggestMobile,
}: {
  isAdmin: boolean;
  authSlot: ReactNode;
  suggestDesktop: ReactNode;
  suggestMobile: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-paper/85 backdrop-blur supports-[backdrop-filter]:bg-paper/70">
      <div className="rule-brass" />
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Wordmark />

        {/* Desktop search — hidden on homepages */}
        {!isHome && (
          <div className="hidden flex-1 justify-center md:flex">
            <SearchField className="w-full max-w-md" />
          </div>
        )}
        {isHome && <div className="hidden flex-1 md:block" />}

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {suggestDesktop}
          {isAdmin && (
            <Link href="/admin" className="btn-ghost rounded-md">
              Admin
            </Link>
          )}
          <span className="mx-1 h-5 w-px bg-hairline" aria-hidden="true" />
          <ThemeToggle />
          <div className="ml-1">{authSlot}</div>
        </nav>

        {/* Mobile controls */}
        <div className="ml-auto flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Menu"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink hover:bg-hairline/40"
          >
            {open ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-hairline bg-paper px-4 pb-5 pt-4 md:hidden">
          <SearchField className="mb-4 w-full" />
          <nav className="flex flex-col gap-1" onClick={() => setOpen(false)}>
            {suggestMobile}
            {isAdmin && (
              <Link href="/admin" className="rounded-md px-3 py-2.5 text-sm font-medium text-ink hover:bg-hairline/40">
                Admin dashboard
              </Link>
            )}
          </nav>
          <div className="mt-4 border-t border-hairline pt-4">{authSlot}</div>
        </div>
      )}
    </header>
  );
}
