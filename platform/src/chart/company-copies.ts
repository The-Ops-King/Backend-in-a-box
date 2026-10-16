import fs from "node:fs";
import path from "node:path";
import { parseDefinition, type Definition } from "@/engine/definition";

const INSTALLS = path.resolve(__dirname, "../../installs");
/** Every company's own workflow copies kept in the repo (installs/<company>/<workflow>.json, with a definition: PMU's, D100; Dating Nelly's, D118), named <company>/<workflow>. */
export function companyCopies(): { name: string; def: Definition }[] {
  return fs.readdirSync(INSTALLS, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) =>
    fs.readdirSync(path.join(INSTALLS, d.name)).filter((f) => f.endsWith(".json")).flatMap((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(INSTALLS, d.name, f), "utf8")) as { definition?: unknown };
      return raw.definition ? [{ name: `${d.name}/${f.replace(/\.json$/, "")}`, def: parseDefinition(raw.definition) }] : [];
    }));
}
