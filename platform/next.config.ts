import type { NextConfig } from "next";

/**
 * Next hosts the engine (cron tick, admin endpoints, webhooks) and the JSON API. The dashboard itself is the Vite React
 * app under public/app: every /app/* path and the closer's /eod/<token> link serve its shell, and the app routes from there.
 */
const config: NextConfig = {
  serverExternalPackages: ["pg"],
  async rewrites() { return { afterFiles: [{ source: "/app/:path*", destination: "/app/index.html" }, { source: "/eod/:token", destination: "/app/index.html" }] }; },
  async redirects() { return [{ source: "/", destination: "/app", permanent: false }]; },
};
export default config;
