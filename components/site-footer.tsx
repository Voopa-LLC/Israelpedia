"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const FOOTER_LINKS = [
  { label: "About", href: "/about" },
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms of Use", href: "/terms" },
  { label: "Contact Us", href: "/contact" },
];

/**
 * The home page's own footer. `tinted` gives it its own background so it
 * separates from the page above — the article page needs that, since its body
 * is white to the edge; the home page already has a coloured band above it.
 */
function HomeFooter({ year, tinted = false }: { year: number; tinted?: boolean }) {
  return (
    <footer className={`hp-footer${tinted ? " is-tinted" : ""}`}>
      <div className="hp-shell grid gap-8 pb-6 pt-9 md:grid-cols-[1.4fr_1fr]">
        <p className="hp-footer-text max-w-[26rem]">
          IsraelPedia is an educational online resource about the Jewish people
          and Israel, bringing reliable, evidence-based information together in
          one place — from ancient history to the present day.
        </p>

        <nav className="flex flex-col gap-2 md:justify-self-end" aria-label="Footer">
          {FOOTER_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="hp-footer-link">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="hp-shell pb-8">
        <span className="hp-copyright">© {year} IsraelPedia</span>
      </div>
    </footer>
  );
}

export default function SiteFooter() {
  const year = new Date().getFullYear();
  const pathname = usePathname();

  // Article pages share the home page's footer; every other route keeps the
  // original site footer.
  if (pathname === "/") return <HomeFooter year={year} />;
  if (
    pathname.startsWith("/article/") ||
    pathname === "/search" ||
    pathname === "/suggest" ||
    pathname === "/signin" ||
    pathname === "/register"
  ) {
    return <HomeFooter year={year} tinted />;
  }

  return (
    <footer className="mt-20 border-t border-hairline bg-card">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <span className="font-display text-xl font-bold">
            <span className="text-techelet">Israel</span>
            <span className="text-ink">Pedia</span>
          </span>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">
            A sourced reference to Israel and the Jewish world — history,
            culture, religion, language, science, and communities worldwide.
            Every article is written to be accurate, neutral, and properly
            cited.
          </p>
        </div>

        <nav className="flex flex-col gap-2 text-sm" aria-label="Footer">
          <span className="eyebrow mb-1">Explore</span>
          <Link href="/" className="text-muted transition-colors hover:text-techelet">
            All articles
          </Link>
          <Link href="/?q=history" className="text-muted transition-colors hover:text-techelet">
            History
          </Link>
          <Link href="/?q=culture" className="text-muted transition-colors hover:text-techelet">
            Culture
          </Link>
          <Link href="/suggest" className="text-muted transition-colors hover:text-techelet">
            Suggest a topic
          </Link>
        </nav>

        <div className="flex flex-col gap-2 text-sm">
          <span className="eyebrow mb-1">About</span>
          <p className="text-muted leading-relaxed">
            Articles are reviewed by human editors before publication. AI-drafted
            entries never publish without review.
          </p>
        </div>
      </div>

      <div className="border-t border-hairline">
        <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-5 text-xs text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>© {year} IsraelPedia. All rights reserved.</span>
          <span>Built for readers, editors, and researchers.</span>
        </div>
      </div>
    </footer>
  );
}
