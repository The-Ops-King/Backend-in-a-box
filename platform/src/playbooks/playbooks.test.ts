/**
 * D142: playbooks. Every company the repo keeps a playbook for has copies that are exactly what its playbook builds from the
 * current templates (a template changed and nobody rebuilt: this fails, naming the file), every playbook says how it sells, and
 * bad params are refused naming the param.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { playbooks, playbookOf } from "@/playbooks";
import { companyBuild, playbookCompanies } from "@/playbooks/files";
import { parseDefinition } from "@/engine/definition";

describe("playbooks", () => {
  it("each company's copies are what its playbook builds from today's templates (pnpm exec tsx scripts/build-copies.ts <company>)", () => {
    expect(playbookCompanies()).toEqual(["dating-nelly", "pmu"]);
    for (const company of playbookCompanies()) {
      const { files } = companyBuild(company);
      expect(files.length, company).toBeGreaterThan(0);
      for (const f of files) expect(fs.readFileSync(f.file, "utf8"), `${path.basename(path.dirname(f.file))}/${path.basename(f.file)} is stale: build it again, then save the copies`).toBe(f.text);
    }
  });

  it("a playbook's `changes` are exactly the templates its copies change or take over", () => {
    for (const company of playbookCompanies()) {
      const { playbook, files } = companyBuild(company);
      const touched = files.filter((x) => !x.file.endsWith(`${company}.json`)).map((x) => JSON.parse(x.text) as { workflow: string; create?: { takesOver?: string } })
        .map((c) => (c.create ? c.create.takesOver : c.workflow)).filter((x): x is string => !!x);
      expect([...new Set(touched)].sort(), company).toEqual([...playbookOf(playbook).changes].sort());
    }
  });

  it("every copy a playbook builds is a workflow the engine reads", () => {
    for (const company of playbookCompanies())
      for (const f of companyBuild(company).files.filter((x) => !x.file.endsWith(`${company}.json`))) expect(() => parseDefinition(JSON.parse(f.text).definition), f.file).not.toThrow();
  });

  it("each playbook has its own slug and says how it sells", () => {
    expect(new Set(playbooks.map((p) => p.slug)).size).toBe(playbooks.length);
    for (const p of playbooks) { expect(p.about.length, p.slug).toBeGreaterThan(20); expect(p.traits.booking.length, p.slug).toBeGreaterThan(0); }
    expect(playbookOf("setter-closer").build("hair", undefined, {})).toEqual({ copies: [] });
  });

  it("bad params are refused, naming what is wrong; an unknown playbook names the ones there are", () => {
    const params = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../installs/pmu/playbook.json"), "utf8")).params;
    expect(() => playbookOf("one-board").build("x", { ...params, stages: { ...params.stages, noShow: "" } }, {})).toThrow(/one-board params: stages\.noShow/);
    expect(() => playbookOf("one-board").build("x", undefined, {})).toThrow(/one-board params/);
    expect(() => playbookOf("two-boards")).toThrow(/setter-closer, one-board, application-triage/);
  });
});
