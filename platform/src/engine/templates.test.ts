import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDefinition, extractManifest, indexDefinition } from "./definition";
import { referencedPaths, KNOWN_ROOTS } from "./template";
import { templates } from "@/templates";

const schema = readFileSync(path.resolve(process.cwd(), "..", "engine", "schema.sql"), "utf8");
const vocab = new Set([...schema.matchAll(/\('([a-z_.]+)','[a-z]+'\)/g)].map((m) => m[1]).filter((v) => v.includes(".")));

describe("shipped templates", () => {
  it("has the full core set", () => expect(templates.map((t) => t.slug).sort()).toEqual([
    "agreement-chase", "agreement-send-manually", "agreement-signed", "booking-decision", "calendar-availability", "call-booked", "call-cancelled", "call-outcome", "call-recorded", "cancellation-rebook", "deal-closed", "eod-filed", "eod-reminder", "health-check", "new-lead", "no-show-recovery", "payment-failed", "payment-recorded", "post-call-follow-up", "pre-call-sequence", "reactivation", "setter-call-logged", "speed-to-lead", "wrap-ups"]));
  for (const t of templates) {
    it(`${t.slug}: parses, triggers on a real event, references only known paths, and its manifest is sane`, () => {
      const def = parseDefinition(t.definition);
      for (const trig of indexDefinition(def).triggers) expect(vocab.has(trig.event) || (trig.event === "schedule" && !!trig.schedule), `${trig.event} not in event_types`).toBe(true);
      const walk = (v: unknown): string[] => typeof v === "string" ? referencedPaths(v) : Array.isArray(v) ? v.flatMap(walk) : v && typeof v === "object" ? Object.values(v).flatMap(walk) : [];
      for (const p of walk(def.nodes)) expect(KNOWN_ROOTS.includes(p.split(".")[0]), `unknown path root in ${t.slug}: ${p}`).toBe(true);
      const m = extractManifest(def);
      expect(m.bindings.find((b) => b.key === "crm.location_id")?.required).toBe(true);
      for (const b of m.bindings) if (b.key.startsWith("slack.")) expect(b.required).toBe(false);
    });
    it(`${t.slug}: tag steps never sit next to each other (one tags step does the adding and removing)`, () => {
      const def = parseDefinition(t.definition);
      const isTag = (id: string) => ["tags", "set_tag", "remove_tag"].includes(def.nodes.find((n) => n.id === id)?.type ?? "");
      for (const e of def.edges) expect(isTag(e.from) && isTag(e.to), `${t.slug}: ${e.from} → ${e.to} are two tag steps in a row`).toBe(false);
    });
  }
  it("the shipped flows that add and remove tags do it in one step, adds before removes", () => {
    const node = (slug: string, id: string) => parseDefinition(templates.find((t) => t.slug === slug)!.definition).nodes.find((n) => n.id === id);
    expect(node("call-booked", "s5")).toMatchObject({ type: "tags", add: ["stat-booked", "stat-self-booked", "meta booked call"], remove: ["seq-no-show", "seq-nurture", "seq-winback", "opt-in lead"] });
    expect(node("call-booked", "b6")).toMatchObject({ type: "tags", add: ["stat-booked", "stat-set", "meta booked call"], remove: ["seq-no-show", "seq-nurture", "seq-winback", "opt-in lead"] });
    expect(node("call-cancelled", "n5")).toMatchObject({ type: "tags", add: ["stat-cancelled"], remove: ["stat-booked", "stat-self-booked", "stat-set", "stat-confirmed"] });
    expect(node("payment-recorded", "f1")).toMatchObject({ type: "tags", add: ["pay-paid-full"], remove: ["pay-plan-active"] });
    expect(node("booking-decision", "y1")).toMatchObject({ type: "tags", add: ["stat-confirmed"], remove: ["stat-unconfirmed"] });
    expect(node("agreement-send-manually", "g1")).toMatchObject({ type: "tags", add: ["stat-agreement-sent"], remove: ["sys-send-agreement-manually"] });
  });
});
