import { auth } from "@/auth";
import HeaderShell from "./header-shell";
import AuthButtons from "./auth-buttons";
import SuggestLink from "./suggest-link";

export default async function SiteHeader() {
  // auth() can throw JWTSessionError on an invalid/expired token, which we treat
  // as "not signed in" rather than crashing the page.
  let session = null;
  try {
    session = await auth();
  } catch {}

  const isLoggedIn = !!session?.user;
  const isAdmin = (session?.user as any)?.role === "admin";

  // Both treatments are rendered here because the slots need server-side auth,
  // and HeaderShell — which knows the route — picks one. The home page uses the
  // *Home slots; every other page uses the originals, unchanged.
  return (
    <HeaderShell
      isAdmin={isAdmin}
      authSlot={<AuthButtons />}
      authSlotHome={<AuthButtons variant="home" />}
      suggestDesktop={<SuggestLink isLoggedIn={isLoggedIn} variant="desktop" />}
      suggestMobile={<SuggestLink isLoggedIn={isLoggedIn} variant="mobile" />}
      suggestHome={<SuggestLink isLoggedIn={isLoggedIn} variant="home" />}
    />
  );
}
