/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  reactStrictMode: true,
  // self-contained server for the packaged desktop app (node server.js)
  output: "standalone",
  outputFileTracingRoot: import.meta.dirname,
  devIndicators: false,
  // the app build uses its own folder so it never disturbs a running `next dev`
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};
export default nextConfig;
