import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        surface2: "var(--surface-2)",
        surface3: "var(--surface-3)",
        line: "var(--border)",
        lineStrong: "var(--border-strong)",
        ink: "var(--text)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        accent: { DEFAULT: "var(--accent)", hover: "var(--accent-hover)", soft: "var(--accent-soft)", ink: "var(--accent-ink)" },
        ok: { DEFAULT: "var(--ok)", soft: "var(--ok-soft)" },
        warn: { DEFAULT: "var(--warn)", soft: "var(--warn-soft)" },
        danger: { DEFAULT: "var(--danger)", soft: "var(--danger-soft)" },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Segoe UI", "Inter", "system-ui", "sans-serif"],
        mono: ["SF Mono", "ui-monospace", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: { xl2: "0.9rem" },
      boxShadow: { s1: "var(--shadow-sm)", s2: "var(--shadow-md)", pop: "var(--shadow-pop)" },
      keyframes: {
        rise: { "0%": { opacity: "0", transform: "translateY(4px)" }, "100%": { opacity: "1", transform: "none" } },
        blink: { "0%,45%": { opacity: "1" }, "55%,100%": { opacity: "0" } },
      },
      animation: {
        rise: "rise .22s cubic-bezier(.2,.7,.3,1) both",
        blink: "blink 1.1s steps(1,end) infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
