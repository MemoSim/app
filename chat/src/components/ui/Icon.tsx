"use client";

/**
 * Inline SVG icon set (no icon dependency). Stroke icons on a 24×24 grid, `currentColor`, 1.7 stroke.
 * Add new icons to PATHS only — sizes and alignment are handled by the caller.
 */

const PATHS: Record<string, string> = {
  send: "M12 19V5M12 5l-6 6M12 5l6 6",
  stop: "M8 8h8v8H8z",
  settings:
    "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7.1 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 14.1a1.7 1.7 0 0 0-1.6-1H1.3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3 7.1a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 7.36 2.9H7.4a1.7 1.7 0 0 0 1-1.6V1.3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.04a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  chevron: "m6 9 6 6 6-6",
  check: "m4 12.5 5 5L20 6.5",
  x: "M6 6l12 12M18 6 6 18",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z",
  dots: "M12 6h.01M12 12h.01M12 18h.01",
  copy: "M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z",
  monitor: "M3 5h18v11H3zM9 20h6M12 16v4",
  play: "m8 5 11 7-11 7V5Z",
  code: "m9 8-5 4 5 4M15 8l5 4-5 4",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  book: "M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2V5ZM8 7h6M8 11h6",
  sliders: "M4 8h10M18 8h2M4 16h4M12 16h8M15 5v6M8 13v6",
  flask: "M9 3h6M10 3v6L5 19a1.6 1.6 0 0 0 1.4 2h11.2A1.6 1.6 0 0 0 19 19l-5-10V3M7.5 14h9",
  waves: "M2 8c2.5-3 5-3 7.5 0S15 11 17.5 8 22 5 22 5M2 16c2.5-3 5-3 7.5 0S15 19 17.5 16 22 13 22 13",
  dot: "M12 12h.01",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  pencil: "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z",
  arrowLeft: "M19 12H5M11 6l-6 6 6 6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01",
  warning: "M12 3 2 20h20L12 3ZM12 9v5M12 17h.01",
  // tool icons
  read: "M6 3h9l5 5v13H6V3ZM15 3v5h5",
  build: "M14 3 5 12l3 3 9-9-3-3ZM3 21l4-1 11-11-3-3L4 17l-1 4Z",
  run: "m7 4 12 8-12 8V4Z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  widget: "M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z",
  world: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 9h18M3 15h18M9 3c-2 3-2 15 0 18M15 3c2 3 2 15 0 18",
  export: "M12 15V3M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4",
  test: "M9 3h6M10 3v6L5 19a1.6 1.6 0 0 0 1.4 2h11.2A1.6 1.6 0 0 0 19 19l-5-10V3",
  files: "M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
};

export type IconName = keyof typeof PATHS | string;

export default function Icon({ name, size = 15, className = "" }: { name: IconName; size?: number; className?: string }) {
  const d = PATHS[name] ?? PATHS.dot!;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/** MemoSim mark: a phase-wave in a rounded tile. Used in the header and the empty state. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-[8px] text-accent-ink"
      style={{ width: size, height: size, background: "linear-gradient(150deg, var(--accent), var(--accent-hover))" }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" aria-hidden="true">
        <path d="M2 15c3-7 6-7 9 0s6 7 9 0" />
      </svg>
    </span>
  );
}
