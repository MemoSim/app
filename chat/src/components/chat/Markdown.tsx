"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { dirOf, textOf } from "@/lib/bidi";

/**
 * Mixed Persian/English chat. Every block (paragraph, heading, list, quote) gets its OWN direction from its first
 * strong character, so an English paragraph stays left-to-right inside a Persian answer and list markers sit on the
 * correct side. Computed here instead of `dir="auto"`: browsers skip children that carry their own `dir` when
 * auto-detecting, which left nested lists left-to-right while their text was right-to-left.
 */
const block = (Tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "blockquote") =>
  function Block({ node, ...props }: { node?: Parameters<typeof textOf>[0] } & React.HTMLAttributes<HTMLElement>) {
    return <Tag dir={dirOf(textOf(node))} {...(props as object)} />;
  };

function CodeBlock({ children, node: _node, ...props }: { node?: unknown } & React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (no permission) — no UI change */
    }
  }
  return (
    <div className="group/code relative my-1.5">
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[10.5px] opacity-0 transition-opacity group-hover/code:opacity-100"
        style={{ background: "var(--surface-2)", color: "var(--muted)", border: "1px solid var(--border)" }}
        aria-label="Copy code"
      >
        {copied ? "copied" : "copy"}
      </button>
      <pre
        ref={ref}
        dir="ltr"
        {...props}
        className="overflow-x-auto rounded-lg p-2.5 font-mono text-[11.5px] leading-relaxed"
        style={{ background: "var(--code-bg)", border: "1px solid var(--border)" }}
      >
        {children}
      </pre>
    </div>
  );
}

const MD_COMPONENTS = {
  p: block("p"),
  h1: block("h1"),
  h2: block("h2"),
  h3: block("h3"),
  h4: block("h4"),
  h5: block("h5"),
  h6: block("h6"),
  ul: block("ul"),
  ol: block("ol"),
  blockquote: block("blockquote"),
  pre: CodeBlock,
};

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat min-w-0">
      <ReactMarkdown components={MD_COMPONENTS}>{text.trim()}</ReactMarkdown>
    </div>
  );
}

export { dirOf };
