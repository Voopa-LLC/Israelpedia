"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle({
  className = "inline-flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:text-techelet hover:bg-hairline/40",
}: {
  className?: string;
}) {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);

    const apply = () => {
      const root = document.documentElement;
      root.classList.toggle("dark", next);
      try { localStorage.setItem("ip-theme", next ? "dark" : "light"); } catch {}
    };

    if ("startViewTransition" in document) {
      // Disable per-element CSS transitions inside the callback so they don't
      // fight the page-level crossfade (e.g. select transition-colors settling
      // after the VT finishes). Re-enable once the VT is fully done.
      const vt = (document as any).startViewTransition(() => {
        document.documentElement.classList.add("vt-in-progress");
        apply();
      });
      vt.finished.then(() => {
        document.documentElement.classList.remove("vt-in-progress");
      });
    } else {
      // Fallback for browsers without View Transitions support.
      const root = document.documentElement;
      root.classList.add("theme-transitioning");
      apply();
      window.setTimeout(() => root.classList.remove("theme-transitioning"), 350);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={mounted && dark ? "Switch to light mode" : "Switch to dark mode"}
      title={mounted && dark ? "Light mode" : "Dark mode"}
      className={className}
    >
      {/* Sun when in dark (click → light); moon when in light (click → dark) */}
      {mounted && dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
