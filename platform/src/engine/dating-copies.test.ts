/**
 * D118: Dating Nelly's own copies (installs/dating-nelly/*.json) are what the build makes from the shipped templates and her
 * words file, differ from the template only where her words go, carry nothing of Hair's, save cleanly, and a welcome whose
 * words are still a placeholder sends nothing, even live.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { templates } from "@/templates";
import { datingCopies, datingPrompts, type DatingWords } from "../../installs/dating/copies";
import { installCompany } from "./install";
import { findCompanyWorkflow, saveDefinition, validateDefinition } from "./definitions";
import { loadCompany } from "./context";
import { applyPayment } from "./lifecycle";
import { dispatchEvent } from "./dispatch";
import { simulate } from "./simulate";
import { tick } from "./runner";
import { fakeAdapters } from "./test-install";
import type { Adapters } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const DIR = path.resolve(__dirname, "../../installs/dating-nelly");
const INSTALL = path.resolve(__dirname, "../../installs/dating-nelly.json");
const words = JSON.parse(fs.readFileSync(path.join(DIR, "words.json"), "utf8")) as DatingWords;
const file = (slug: string) => JSON.parse(fs.readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as { workflow: string; note: string; definition: { nodes: { id: string }[]; edges: unknown[] } };
const template = (slug: string) => templates.find((t) => t.slug === slug)!.definition as unknown as { nodes: { id: string }[]; edges: unknown[] };
const HAIR_WORDS = /hair|scalp|follicle|thinning|saveyourhair|allan|telegram|clinician|burned_before/i;

describe("D118: Dating Nelly's copies", () => {
  it("are exactly what the build makes from the templates and her words (pnpm exec tsx scripts/build-copies.ts dating-nelly --check)", () => {
    const built = datingCopies("dating-nelly", words);
    expect(built.map((c) => c.workflow).sort()).toEqual(fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "words.json").map((f) => f.replace(/\.json$/, "")).sort());
    for (const c of built) expect(file(c.workflow), c.workflow).toEqual(JSON.parse(JSON.stringify(c)));
    const install = JSON.parse(fs.readFileSync(INSTALL, "utf8")) as { prompts: Record<string, string>; salesCall: { objections: string[] } };
    expect(install.prompts).toEqual(datingPrompts(install.salesCall.objections));
  });

  it("differ from the template only in her words: the welcome email and text, and why a setter DQs a lead", () => {
    const changed = (slug: string) => { const t = new Map(template(slug).nodes.map((n) => [n.id, JSON.stringify(n)])); const d = file(slug).definition;
      expect(d.edges).toEqual(template(slug).edges); expect(d.nodes.map((n) => n.id)).toEqual([...t.keys()]);
      return d.nodes.filter((n) => t.get(n.id) !== JSON.stringify(n)).map((n) => n.id); };
    expect(changed("deal-closed")).toEqual(["e1", "e2"]);
    expect(changed("setter-call-logged")).toEqual(["a3", "a4"]);
    // the template still carries Hair's words; her copies carry none
    expect(JSON.stringify(template("deal-closed"))).toMatch(HAIR_WORDS);
    for (const slug of ["deal-closed", "setter-call-logged"]) expect(JSON.stringify(file(slug).definition)).not.toMatch(HAIR_WORDS);
    expect(JSON.stringify(file("setter-call-logged").definition)).not.toMatch(/medical condition|medical, timeline/);
  });

  it("her prompts: her six objections, no medical reason in a setter's triage; everything else is the shipped prompt", () => {
    const p = datingPrompts(["price", "partner", "timing", "fear", "competitor", "think_about_it"]);
    expect(p.call_review).toContain('"primary_objection": "price" | "partner" | "timing" | "fear" | "competitor" | "think_about_it" | ""');
    for (const v of Object.values(p)) expect(v).not.toMatch(/medical|burned_before/);
    expect(p.setter_call_notes).toContain("(budget, timing, decision maker)");
  });

  it("a welcome whose words are real is not held", () => {
    const real: DatingWords = { ...words, welcome: { subject: "Welcome", email: "<p>Hi</p>", sms: "Hi" } };
    const dc = datingCopies("x", real).find((c) => c.workflow === "deal-closed")!.definition as { nodes: { id: string; only_if?: unknown }[] };
    expect(dc.nodes.find((n) => n.id === "e1")!.only_if).toBeUndefined();
    expect(dc.nodes.find((n) => n.id === "e2")!.only_if).toBeUndefined();
  });
});

const sent: { kind: string; body: string }[] = [];
const base = fakeAdapters();
const fake: Adapters = { ...base, read: { ...base.read, listUsers: async () => [{ id: "U-CLOSER", name: "Mitch Sapoff", email: "mitch@d118.test" }] },
  sender: { ...base.sender, sendSms: async (_c, _to, body) => { sent.push({ kind: "sms", body }); return { externalId: "s", accepted: true }; }, sendEmail: async (_c, _to, subject, html) => { sent.push({ kind: "email", body: `${subject}|${html}` }); return { externalId: "e", accepted: true }; } } };

describe.skipIf(!process.env.DATABASE_URL)("D118: Dating Nelly's copies on a company", () => {
  let co: string;
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      const old = await one<{ id: string }>(c, "select id from companies where slug='d118copies'"); if (!old) return;
      await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [old.id]);
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [old.id]);
      for (const t of ["step_effects", "alerts", "slack_posts", "agreements", "sends", "runs", "events", "workflow_triggers", "workflows", "crm_records", "payments", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"])
        await c.query(`delete from ${t} where company_id=$1`, [old.id]);
      await c.query("delete from companies where id=$1", [old.id]);
    });
    const crm = { pipeline_setter: "P-S", pipeline_closer: "P-C", stage_closer_closed_won: "ST-W", assoc_discovery_call_contact: "A-DC", object_sales_call: "custom_objects.dating_sales_call", object_discovery_call: "custom_objects.dating_discovery" };
    co = (await installCompany({ name: "Copies", slug: "d118copies", timezone: "America/New_York", locationId: "LOC", pit: "fake", calendars: { CAL: "closing" }, crm, anthropicKey: "sk-fake", testDomains: ["d118.test"], templates: ["deal-closed", "setter-call-logged"] }, fake)).companyId;
    await asOperator((c) => c.query("update companies set mode='live', send_window_start='00:00', send_window_end='23:59' where id=$1", [co]));
  });

  it("each copy validates as a save would (no problems, nothing missing, drawn exactly) and saves as a new version of that company's copy", async () => {
    for (const slug of ["deal-closed", "setter-call-logged"]) {
      const { definition, note } = file(slug);
      const v = await asOperator((c) => validateDefinition(c, co, definition));
      expect(v.ok ? { missing: v.missing } : v, slug).toEqual({ missing: [] });
      const r = await asOperator(async (c) => { const w = await findCompanyWorkflow(c, co, slug); if (!w.ok) throw new Error(w.why); return saveDefinition(c, { workflowId: w.id, definition, note, dryRun: true }); });
      expect(r, slug).toMatchObject({ ok: true, saved: false, dryRun: true, layout: "tidy" });
      const saved = await asOperator(async (c) => { const w = await findCompanyWorkflow(c, co, slug); if (!w.ok) throw new Error(w.why); return saveDefinition(c, { workflowId: w.id, definition, note }); });
      expect(saved, slug).toMatchObject({ ok: true, saved: true, version: 2 });
    }
  });

  it("live, paid and signed: Deal closed runs to the end and the placeholder welcome email and text are skipped, nothing sent", async () => {
    await asOperator((c) => c.query("update workflows set enabled=true where company_id=$1 and name='Deal closed'", [co]));
    const ct = await asOperator(async (c) => {
      const id = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,'G-WELCOME','Wren','Test','America/New_York') returning id", [co]))!.id;
      await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','wren@d118.test'),($1,$2,'phone','+16025550111')", [co, id]);
      return id;
    });
    await asOperator(async (c) => { const { row } = await loadCompany(c, co); const r = await simulate({ c, company: row, contactId: ct, force: true }, "sign"); expect(r.ok).toBe(true); });
    await asOperator(async (c) => { const ev = await applyPayment(c, co, ct, { whopPaymentId: "pay_welcome", amount: 300, currency: "USD", status: "succeeded", paidAt: new Date(), raw: {} }); await dispatchEvent(c, ev, { contact: { id: ct } }); });
    for (let i = 0; i < 3; i++) await tick(fake, DateTime.now() as DateTime<true>, co);
    const runs = await asOperator((c) => many<{ id: string; status: string; exit_reason: string | null }>(c, "select r.id, r.status, r.exit_reason from runs r join workflows w on w.id=r.workflow_id where w.company_id=$1 and w.name='Deal closed' order by r.started_at", [co]));
    const done = runs.find((r) => r.exit_reason === "closed");
    expect(done, JSON.stringify(runs)).toBeTruthy();
    const steps = await asOperator((c) => many<{ node_id: string; status: string }>(c, "select node_id, status from run_steps where run_id=$1", [done!.id]));
    expect(steps.filter((s) => ["e1", "e2"].includes(s.node_id))).toEqual([{ node_id: "e1", status: "skipped" }, { node_id: "e2", status: "skipped" }]);
    expect(steps.find((s) => s.node_id === "g1")).toMatchObject({ status: "ok" });
    expect(sent).toEqual([]);
    expect(await asOperator((c) => many(c, "select 1 from sends where company_id=$1 and channel in ('sms','email')", [co]))).toEqual([]);
  });
});
