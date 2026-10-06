import { readFileSync, existsSync } from "node:fs";
for (const f of [".env.local", ".env"]) if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
