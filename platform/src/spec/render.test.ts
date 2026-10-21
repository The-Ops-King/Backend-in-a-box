import { describe, expect, it } from "vitest";
import { parseDefinition } from "@/engine/definition";
import { templates } from "@/templates";
import { locate, renderIndex, renderWorkflow, type OfferInfo, type WorkflowInfo } from "./render";
import { loadRepoOffer, repoOffers } from "./sources";

const offer: OfferInfo = { slug: "acme", name: "Acme", source: "db", mode: "test", timezone: "America/Phoenix", sendWindow: { start: "08:00", end: "20:00", transactionalAnyHour: false } };
const def = parseDefinition({
  schema: 1, reentry: "once_per_appointment", premise: { check: "appointment_in_future" },
  nodes: [
    { id: "t1", type: "trigger", event: "appointment.booked" },
    { id: "v1", type: "set_var", key: "greeting", value: "Hi {{contact.first_name}}" },
    { id: "w1", type: "wait", rule: { anchor: "appointment.starts_at", offset: "-1d", tz: "contact" } },
    { id: "s1", type: "send_sms", template: "{{vars.greeting}}, see you tomorrow at {{appointment.starts_at}}", only_if: { exists: "contact.phone" } },
    { id: "p1", type: "slack_post", channel: "{{slack.channel.bookings}}", template: "Booked: {{contact.name}}" },
    { id: "x1", type: "exit", reason: "sent" },
  ],
  edges: [{ from: "t1", to: "v1" }, { from: "v1", to: "w1" }, { from: "w1", to: "s1" }, { from: "s1", to: "p1" }, { from: "p1", to: "x1" }],
});
const wf: WorkflowInfo = { slug: "reminder", name: "Reminder", stage: "pre_call", enabled: true, mode: null, diverged: true, version: 4, template: { slug: "pre-call-sequence", version: 9 }, origin: "live: version 4", definition: def,
  bindings: { "slack.channel.bookings": "C123", "crm.location_id": "loc1" } };

describe("the behavior spec", () => {
  const md = renderWorkflow(offer, wf, "2026-10-21");

  it("lists every step, plumbing included, numbered in walk order, each with its exits", () => {
    for (const [i, id] of ["t1", "v1", "w1", "s1", "p1", "x1"].entries()) expect(md.indexOf(`### ${i + 1}.`)).toBeLessThan(md.indexOf(`Step id \`${id}\``));
    expect(md).toContain("→ step 4 (`s1`)");
    expect(md).toContain("Next: the run ends here.");
  });

  it("shows the exact words a step sends, its condition and where it goes", () => {
    expect(md).toContain("```\n{{vars.greeting}}, see you tomorrow at {{appointment.starts_at}}\n```");
    expect(md).toContain("Runs only if:");
    expect(md).toContain("Goes to: channel {{slack.channel.bookings}}");
    expect(md).toContain("Wait: Wait until 1 day before the call");
  });

  it("states the lock, mode, premise and the settings, with an unbound one called out", () => {
    expect(md).toContain("locked: texts, emails, documents and webhooks reach only the operator's own addresses");
    expect(md).toContain("follows the offer (test)");
    expect(md).toContain("appointment in future");
    expect(md).toContain("| `slack.channel.bookings` | channel | no | `C123` |");
  });

  it("names the engine rules that act on it, with a file and line", () => {
    expect(md).toMatch(/send-lock\.ts:\d+/);
    expect(md).toMatch(/executor\.ts:\d+/);
    expect(md).toMatch(/runner\.ts:\d+/);
  });

  it("is the same text twice (diffs show only real change)", () => {
    expect(renderWorkflow(offer, wf, "2026-10-21")).toBe(md);
  });

  it("finds every engine anchor it cites", () => {
    for (const [f, a] of [["executor.ts", "async function doSend"], ["runner.ts", "async function premiseAlive"], ["send-lock.ts", "export async function checkSendLock"], ["failures.ts", "export const RETRY_SCHEDULE"], ["effects.ts", "export async function claimEffect"], ["runner.ts", "function listenerFired"], ["runner.ts", "deferIntoWindow(now, tz"], ["mode.ts", "export const MODE_WORDS"], ["reentry.ts", "export function reentryKey"]])
      expect(locate(f, a)).toMatch(/:\d+$/);
  });

  it("indexes the offer's workflows with links", () => {
    const idx = renderIndex(offer, [{ w: wf }], "2026-10-21");
    expect(idx).toContain("[Reminder](reminder.md)");
    expect(idx).toContain("| on |");
  });

  it("renders every shipped template and every repo offer without throwing", () => {
    for (const t of templates as unknown as { slug: string; name: string; definition: unknown }[])
      expect(() => renderWorkflow(offer, { slug: t.slug, name: t.name, origin: "template", definition: parseDefinition(t.definition) }, "2026-10-21")).not.toThrow();
    for (const slug of repoOffers()) {
      const { offer: o, rows } = loadRepoOffer(slug);
      expect(o.source).toBe("repo");
      for (const r of rows) if (!r.removed) expect(renderWorkflow(o, r.w, "2026-10-21")).toContain("from repo, may differ from live");
    }
  });
});
