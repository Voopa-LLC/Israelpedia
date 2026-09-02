import Link from "next/link";
import { IsraelPediaLogo } from "./ip-logo";

export default function Wordmark({ className = "", href = "/" }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      className={`ip-wordmark ${className}`}
      aria-label="IsraelPedia — home"
    >
      <IsraelPediaLogo className="ip-wordmark-logo" label={null} />
    </Link>
  );
}
