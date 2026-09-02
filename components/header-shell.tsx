"use client";

import { Suspense, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import Wordmark from "./wordmark";
import ThemeToggle from "./theme-toggle";
import { IsraelPediaLogo } from "./ip-logo";

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

const MenuIcon = ({ open }: { open: boolean }) =>
  open ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
  );

/**
 * The home page's own header. Left is the version tag rather than the
 * wordmark — on the home page the wordmark is the hero, and repeating it
 * here would halve the impact of the one place it is meant to land.
 */
function HomeHeader({
  isAdmin,
  authSlot,
  suggest,
}: {
  isAdmin: boolean;
  authSlot: ReactNode;
  suggest: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <header className="hp-header sticky top-0 z-40">
      <div className="ap-header-shell flex h-16 items-center justify-between gap-4">
        <span className="hp-version">Version_01</span>

        <nav className="hidden items-center gap-1 md:flex">
          {suggest}
          {isAdmin && (
            <Link href="/admin" className="hp-navlink">
              Admin
            </Link>
          )}
          <ThemeToggle className="hp-icon-btn" />
          <span className="mx-1.5 h-4 w-px bg-[var(--hp-border)]" aria-hidden="true" />
          {authSlot}
        </nav>

        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle className="hp-icon-btn" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Menu"
            className="hp-icon-btn"
          >
            <MenuIcon open={open} />
          </button>
        </div>
      </div>

      {open && (
        <div
          className="border-t px-7 pb-5 pt-4 md:hidden"
          style={{ borderColor: "var(--hp-border)", backgroundColor: "var(--hp-surface)" }}
        >
          <nav className="flex flex-col items-start gap-2" onClick={() => setOpen(false)}>
            {suggest}
            {isAdmin && (
              <Link href="/admin" className="hp-navlink">
                Admin
              </Link>
            )}
          </nav>
          <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--hp-border)" }}>
            {authSlot}
          </div>
        </div>
      )}
    </header>
  );
}

/* Icons for the article header's pill search. */
const PillSearchIcon = () => (
  <svg
    className="hp-search-icon"
    width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

const GoArrowIcon = () => (
  <svg
    width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 12h15M13 6l6 6-6 6" />
  </svg>
);

/**
 * Compact search for the article header. It is a real form, so Enter submits
 * whether or not the arrow is clicked.
 */
function BrandSearchInner({ className = "" }: { className?: string }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const currentQuery = pathname === "/search" ? (params.get("q") ?? "") : "";
  return (
    <form action="/search" method="get" role="search" className={className}>
      <div className="hp-search hp-search-sm">
        <PillSearchIcon />
        <input
          key={currentQuery}
          type="search"
          name="q"
          defaultValue={currentQuery}
          placeholder="Search"
          aria-label="Search articles"
          className="hp-search-input"
        />
        <button type="submit" className="hp-search-go" aria-label="Search">
          <GoArrowIcon />
        </button>
      </div>
    </form>
  );
}

function BrandSearch({ className = "" }: { className?: string }) {
  return (
    <Suspense
      fallback={
        <form action="/search" method="get" role="search" className={className}>
          <div className="hp-search hp-search-sm">
            <PillSearchIcon />
            <input
              type="search"
              name="q"
              placeholder="Search"
              aria-label="Search articles"
              className="hp-search-input"
            />
            <button type="submit" className="hp-search-go" aria-label="Search">
              <GoArrowIcon />
            </button>
          </div>
        </form>
      }
    >
      <BrandSearchInner className={className} />
    </Suspense>
  );
}

/**
 * The article page's header: the logo top-left with the search beside it,
 * in the same palette as the article itself.
 */
function ArticleHeader({
  isAdmin,
  authSlot,
  suggest,
}: {
  isAdmin: boolean;
  authSlot: ReactNode;
  suggest: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <header className="hp-header sticky top-0 z-40">
      <div className="ap-header-shell flex h-16 items-center gap-4">
        <Link href="/" className="ap-brand" aria-label="IsraelPedia — home">
          <IsraelPediaLogo className="ap-brand-logo" label={null} />
        </Link>

        <BrandSearch className="ml-6 hidden min-w-0 flex-1 md:block lg:ml-10" />

        <nav className="hidden items-center gap-1 md:flex">
          {suggest}
          {isAdmin && (
            <Link href="/admin" className="hp-navlink">
              Admin
            </Link>
          )}
          <ThemeToggle className="hp-icon-btn" />
          <span className="mx-1.5 h-4 w-px bg-[var(--hp-border)]" aria-hidden="true" />
          {authSlot}
        </nav>

        <div className="ml-auto flex items-center gap-1 md:hidden">
          <ThemeToggle className="hp-icon-btn" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Menu"
            className="hp-icon-btn"
          >
            <MenuIcon open={open} />
          </button>
        </div>
      </div>

      {open && (
        <div
          className="border-t px-7 pb-5 pt-4 md:hidden"
          style={{ borderColor: "var(--hp-border)", backgroundColor: "var(--hp-surface)" }}
        >
          <BrandSearch className="mb-4 w-full" />
          <nav className="flex flex-col items-start gap-2" onClick={() => setOpen(false)}>
            {suggest}
            {isAdmin && (
              <Link href="/admin" className="hp-navlink">
                Admin
              </Link>
            )}
          </nav>
          <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--hp-border)" }}>
            {authSlot}
          </div>
        </div>
      )}
    </header>
  );
}

export default function HeaderShell({
  isAdmin,
  authSlot,
  authSlotHome,
  suggestDesktop,
  suggestMobile,
  suggestHome,
}: {
  isAdmin: boolean;
  authSlot: ReactNode;
  authSlotHome: ReactNode;
  suggestDesktop: ReactNode;
  suggestMobile: ReactNode;
  suggestHome: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isHome = pathname === "/";

  if (isHome) {
    return <HomeHeader isAdmin={isAdmin} authSlot={authSlotHome} suggest={suggestHome} />;
  }

  // Article and search pages get the same palette as the home page but lead
  // with the logo and the search field, rather than the version tag. On the
  // search page that field is pre-filled with the current query, so refining a
  // search never means going back to the home page.
  if (
    pathname.startsWith("/article/") ||
    pathname === "/search" ||
    pathname === "/suggest" ||
    pathname === "/signin" ||
    pathname === "/register"
  ) {
    return <ArticleHeader isAdmin={isAdmin} authSlot={authSlotHome} suggest={suggestHome} />;
  }

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
