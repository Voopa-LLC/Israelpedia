/**
 * The IsraelPedia lockup: ISRAEL · open book under a Star of David · PEDIA.
 *
 * Stroked in currentColor so the mark is literally the same colour as the
 * letters it sits between, in either theme. Used at hero size on the home
 * page and at small size in the article header.
 */
export function IpBookMark({ className = "hp-wordmark-mark" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 56 46"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M28 2 36.66 17 19.34 17Z" />
      <path d="M28 22 19.34 7 36.66 7Z" />
      <path d="M28 27C22 23.5 11 22.5 4 25L4 38C11 35.5 22 36.5 28 41" />
      <path d="M28 27C34 23.5 45 22.5 52 25L52 38C45 35.5 34 36.5 28 41" />
      <path d="M28 27 28 41" />
    </svg>
  );
}

/** Word + mark + word. The caller supplies the type size via its own class. */
export function IpLockup({ markClassName }: { markClassName?: string }) {
  return (
    <>
      Israel
      <IpBookMark className={markClassName} />
      Pedia
    </>
  );
}
