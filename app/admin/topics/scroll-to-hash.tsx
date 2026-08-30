"use client";

import { useEffect } from "react";

/**
 * Scroll to the element named by the URL hash whenever the page's contents
 * change identity.
 *
 * The browser does this by itself on a full page load, but this page arrives
 * three different ways and only one of them is a full load:
 *
 *   the search form     a GET form submit — a real navigation, browser scrolls
 *   Add topics          a server action calling redirect() — the App Router
 *                       navigates on the client, and whether it honours a
 *                       fragment is not something to bet the behaviour on
 *   the filter/pager    plain <Link>s to the same route with a new hash
 *
 * Rather than depend on each of those handling `#queue` the same way, this runs
 * afterwards and puts the reader where they asked to be. When the browser has
 * already scrolled correctly it is a no-op — scrolling to where you already are
 * changes nothing.
 *
 * `trigger` is what makes it fire again. A server action that redirects to the
 * same route does NOT remount this component, so an effect with an empty
 * dependency list would run once and never again. The parent passes a string
 * describing what is being shown; when that changes, the reader has been taken
 * somewhere new and the scroll is re-applied.
 */
export default function ScrollToHash({ trigger }: { trigger: string }) {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    // `scroll-margin-top` on the target keeps it clear of the top edge.
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [trigger]);

  return null;
}
