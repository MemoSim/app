import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "MemoSim",
  description: "Build and explore NetLogo simulation models with MemoSim.",
  icons: { icon: "/memosim-logo.svg" },
};

/**
 * Applies the saved theme (auto / light / dark) before first paint so the chat panel never flashes white
 * inside the desktop window. The picker lives in the header menu and only writes the same localStorage key.
 */
const THEME_SCRIPT = `(function(){try{
  var t = localStorage.getItem("memosim:theme") || "auto";
  var dark = t === "dark" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-screen">{children}</body>
    </html>
  );
}
