/**
 * D142: a company's playbook as the repo keeps it: installs/<company>/playbook.json (which playbook, its params) and
 * installs/<company>.json (its install file). `companyBuild` says every file the build makes, with its text, so the build script
 * writes them and a test holds the committed ones to it (a copy that fell behind its template fails the test).
 */
import fs from "node:fs";
import path from "node:path";
import { playbookOf, type InstallBits, type PlaybookFile } from "./index";

export const INSTALLS = path.resolve(__dirname, "../../installs");
/** The companies the repo keeps a playbook for. */
export const playbookCompanies = (): string[] => fs.readdirSync(INSTALLS).filter((d) => fs.existsSync(path.join(INSTALLS, d, "playbook.json"))).sort();

export function companyBuild(company: string): { playbook: string; files: { file: string; text: string }[] } {
  const dir = path.join(INSTALLS, company), installFile = path.join(INSTALLS, `${company}.json`);
  const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
  const pf = read(path.join(dir, "playbook.json")) as PlaybookFile;
  const params: Record<string, unknown> = { ...(pf.params ?? {}) };
  for (const [k, f] of Object.entries(pf.files ?? {})) params[k] = read(path.join(dir, f));
  const install = fs.existsSync(installFile) ? read(installFile) as InstallBits & Record<string, unknown> : {};
  const built = playbookOf(pf.playbook).build(company, Object.keys(params).length ? params : undefined, install);
  const files = built.copies.map((c) => ({ file: path.join(dir, `${c.workflow}.json`), text: JSON.stringify(c, null, 1) + "\n" }));
  if (built.install) files.push({ file: installFile, text: JSON.stringify({ ...install, ...built.install }, null, 2) + "\n" });
  return { playbook: pf.playbook, files };
}
