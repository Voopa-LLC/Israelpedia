import Link from "next/link";

/**
 * "Suggest an article" entry point, shown to everyone.
 * - Signed in  → links straight to the suggest form.
 * - Signed out → links to /signin with callbackUrl=/suggest.
 *
 * "home" is the home page's own treatment; "desktop" and "mobile" are the
 * site-wide header used on every other page.
 */
export default function SuggestLink({
  isLoggedIn,
  variant,
}: {
  isLoggedIn: boolean;
  variant: "desktop" | "mobile" | "home";
}) {
  const className =
    variant === "desktop"
      ? "btn-ghost rounded-md"
      : variant === "home"
        ? "hp-navlink"
        : "w-full rounded-md px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-hairline/40";

  return (
    <Link
      href={isLoggedIn ? "/suggest" : "/signin?callbackUrl=%2Fsuggest"}
      className={className}
    >
      Suggest an article
    </Link>
  );
}
