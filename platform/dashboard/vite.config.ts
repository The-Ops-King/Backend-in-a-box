import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/** The dashboard: a Vite React app Next serves at /app (and the closer's page at /eod/<token>) from public/app. */
export default defineConfig({
  root: __dirname,
  base: "/app/",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "../src"), "~": path.resolve(__dirname, "src") } },
  build: { outDir: path.resolve(__dirname, "../public/app"), emptyOutDir: true, sourcemap: false },
  server: { port: 5177, proxy: { "/api": "http://localhost:3077" } },
});
