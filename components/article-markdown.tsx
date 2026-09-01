import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children } from "react";

/** True for a link whose whole text is a footnote marker: [8] */
function isCitation(children: React.ReactNode): boolean {
  const parts = Children.toArray(children);
  if (parts.length !== 1 || typeof parts[0] !== "string") return false;
  return /^\[\d+\]$/.test(parts[0].trim());
}

/**
 * Renders an article body (Markdown).
 *
 * `className` selects the typographic treatment: the article page passes
 * "ap-prose". The older ".prose-article" styling is still in globals.css.
 */
export default function ArticleMarkdown({
  body,
  className = "prose-article",
  dropcap = true,
}: {
  body: string;
  className?: string;
  dropcap?: boolean;
}) {
  // Articles often lead with a level-1 heading that repeats the title.
  // The page already renders the title as its <h1>, so strip a single
  // leading H1 to avoid a duplicate.
  const cleaned = body.replace(/^\s*#\s+.*(\r?\n)+/, "");

  const firstChar = cleaned.trimStart()[0] ?? "";
  const opensWithProse = !"#-*>|`=".includes(firstChar);

  return (
    <div className={`${className} ${dropcap && opensWithProse ? "has-dropcap" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => {
            const external = !!href && /^https?:\/\//.test(href);
            // Footnote markers get their own class so they read as citations
            // rather than as ordinary inline links.
            const cite = isCitation(children);
            return (
              <a
                href={href}
                className={cite ? "ap-cite" : undefined}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}
