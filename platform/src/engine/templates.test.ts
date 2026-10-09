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
  }
});
