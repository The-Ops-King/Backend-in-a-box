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
import { datingCopies, datingPrompts, type DatingSetup, type DatingWords } from "../../installs/dating/copies";
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
const setup = JSON.parse(fs.readFileSync(path.join(DIR, "copies.json"), "utf8")) as DatingSetup;
const installBits = () => JSON.parse(fs.readFileSync(INSTALL, "utf8")) as { scopeTag: string; calendars: Record<string, { term: string; name?: string }> };
const file = (slug: string) => JSON.parse(fs.readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as { workflow: string; note: string; definition: { nodes: { id: string }[]; edges: unknown[] } };
const template = (slug: string) => templates.find((t) => t.slug === slug)!.definition as unknown as { nodes: { id: string }[]; edges: unknown[] };
const HAIR_WORDS = /hair|scalp|follicle|thinning|saveyourhair|allan|telegram|clinician|burned_before/i;

describe("D118: Dating Nelly's copies", () => {
  it("are exactly what the build makes from the templates and her words (pnpm exec tsx scripts/build-copies.ts dating-nelly --check)", () => {
    const built = datingCopies("dating-nelly", words, { setup, install: installBits() });
    expect(built.map((c) => c.workflow).sort()).toEqual(fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "words.json" && f !== "copies.json").map((f) => f.replace(/\.json$/, "")).sort());
    for (const c of built) expect(file(c.workflow), c.workflow).toEqual(JSON.parse(JSON.stringify(c)));
    const install = JSON.parse(fs.readFileSync(INSTALL, "utf8")) as { prompts: Record<string, string>; salesCall: { objections: string[] } };
    expect(install.prompts).toEqual(datingPrompts(install.salesCall.objections));
  });

  it("differ from the template only in her words (the welcome email and text, why a setter DQs a lead) and the won card's value (D130)", () => {
    const changed = (slug: string) => { const t = new Map(template(slug).nodes.map((n) => [n.id, JSON.stringify(n)])); const d = file(slug).definition;
      expect(d.edges).toEqual(template(slug).edges); expect(d.nodes.map((n) => n.id)).toEqual([...t.keys()]);
      return d.nodes.filter((n) => t.get(n.id) !== JSON.stringify(n)).map((n) => n.id); };
    expect(changed("deal-closed")).toEqual(["p1", "e1", "e2"]);
    expect(file("deal-closed").definition.nodes.find((n) => n.id === "p1")).toEqual({ ...template("deal-closed").nodes.find((n) => n.id === "p1"), value: "{{contact.revenue}}" });
    expect(changed("setter-call-logged")).toEqual(["a3", "a4"]);
    // the template still carries Hair's words; her copies carry none
    expect(JSON.stringify(template("deal-closed"))).toMatch(HAIR_WORDS);
    for (const slug of ["deal-closed", "setter-call-logged"]) expect(JSON.stringify(file(slug).definition)).not.toMatch(HAIR_WORDS);
    expect(JSON.stringify(file("setter-call-logged").definition)).not.toMatch(/medical condition|medical, timeline/);
  });

  it("D123, D142: her booked-call workflows are Call booked held to one call type each: the closing call with one card fork after the booking paths as PMU's (D105, D107); the triage call with a Discovery Call record and no closer card, task or Sales Call; New from Typeform tags and starts New lead once", () => {
    type N = { id: string } & Record<string, unknown>; type E = { from: string; to: string; label?: string; when?: unknown; else?: boolean };
    const t = new Map(template("call-booked").nodes.map((n) => [n.id, n as N]));
    const def = (slug: string) => file(slug).definition as unknown as { nodes: N[]; edges: E[] };
    const triage = def("triage-call-booked"), closing = def("closing-call-booked");
    const at = (d: typeof triage, id: string) => d.nodes.find((n) => n.id === id)!;
    const ways = (d: typeof triage, from: string) => d.edges.filter((e) => e.from === from).map((e) => `${e.to}${e.label ? ` (${e.label})` : ""}`).sort();
    // closing: every step of the template but the closer card in each path (s4, b5), which the fork's two card steps replace
    { const ids = closing.nodes.map((n) => n.id);
      expect([...t.keys()].filter((id) => !ids.includes(id))).toEqual(["s4", "b5"]);
      expect(ids.filter((id) => !t.has(id)).sort()).toEqual(["b_suffix", "c_new", "c_rs", "f_card", "s_suffix"]);
      expect(ways(closing, "s5")).toEqual(["f_card"]); expect(ways(closing, "b6")).toEqual(["f_card"]);
      expect(ways(closing, "f_card")).toEqual(["c_new (a new booking)", "c_rs (a reschedule)"]);
      expect(ways(closing, "c_new")).toEqual(["k3"]); expect(ways(closing, "k3")).toEqual(["k4"]); expect(ways(closing, "c_rs")).toEqual(["k5"]); expect(ways(closing, "k5")).toEqual(["k4"]);
      expect(at(closing, "c_rs")).toMatchObject({ type: "pipeline_card", pipeline: "{{crm.pipeline_closer}}", stage: "{{crm.stage_closer_scheduled}}", keep_name: true });
      expect((at(closing, "k4").properties as Record<string, string>).call_type).toBe("closing");
      for (const id of ids.filter((id) => t.has(id) && !["t1", "t2", "k3", "k5", "k4", "v4"].includes(id))) expect(at(closing, id), `closing ${id}`).toEqual(t.get(id)); }
    // triage: the booking paths and the setter card; its record a Discovery Call, owned by whoever takes the call; nothing of the closing call
    { const ids = triage.nodes.map((n) => n.id);
      expect([...t.keys()].filter((id) => !ids.includes(id))).toEqual(["s4", "b5", "k3", "k5", "k4"]);
      expect(ids.filter((id) => !t.has(id)).sort()).toEqual(["d1", "d_rs"]);
      expect(ways(triage, "s5")).toEqual(["d_rs"]); expect(ways(triage, "b6")).toEqual(["d_rs"]); expect(ways(triage, "d_rs")).toEqual(["d1"]); expect(ways(triage, "d1")).toEqual(["v4"]);
      expect(at(triage, "d1")).toMatchObject({ type: "crm_record", object: "{{crm.object_discovery_call | default:custom_objects.discovery_call}}", key: "{{appointment.slot_key}}", owner: "{{appointment.closer.ghl_user_id | default:}}",
        properties: expect.objectContaining({ setter: "{{appointment.closer.name | default:}}", outcome: "scheduled" }) });
      expect(at(triage, "d_rs")).toMatchObject({ key: "{{event.slot.from | default:}}", if_missing: "skip", only_if: { eq: ["{{event._type}}", "appointment.rescheduled"] }, properties: { outcome: "rescheduled" } });
      expect(JSON.stringify(triage)).not.toMatch(/pipeline_closer|object_sales_call|create_task/);
      for (const id of ["s5", "b6"]) expect(at(triage, id).add).toEqual([...(t.get(id) as unknown as { add: string[] }).add, "stat-triage-first"]); }
    for (const [d, type, card] of [[triage, "Triage call", "triage call"], [closing, "Closing call", "closing call"]] as const) {
      for (const id of ["t1", "t2"]) expect(at(d, id).match).toEqual({ eq: ["{{appointment.term.name}}", type] });
      expect(at(d, "v4")).toMatchObject({ value: { name: `${card.charAt(0).toUpperCase()}${card.slice(1)} rescheduled` }, else_value: { name: `New ${card} booked` } });
    }
    for (const id of ["s5", "b6"]) expect(at(closing, id)).toEqual(t.get(id));
    expect(JSON.stringify(closing)).not.toContain("stat-triage-first");
    for (const slug of ["triage-call-booked", "closing-call-booked"]) expect(file(slug)).toMatchObject({ create: { takesOver: "call-booked", stage: "booking" } });
    const nf = file("new-from-typeform") as unknown as { name: string; create: Record<string, unknown>; definition: { nodes: Record<string, unknown>[] } };
    expect(nf.name).toBe("New from Typeform");
    expect(nf.create).not.toHaveProperty("takesOver");
    expect(nf.definition.nodes.map((n) => [n.type, n.event ?? n.add ?? null])).toEqual([["trigger", "form.submitted"], ["tags", ["dating"]], ["record", "lead.created"], ["exit", null]]);
    expect(nf.definition.nodes[2]).toMatchObject({ start: true, only_if: { eq: ["{{contact.is_lead}}", false] } });
  });

  it("D123: the build refuses a closing calendar no booked workflow takes (it would run nothing once Call booked is taken over), and a type no calendar books", () => {
    const inst = installBits();
    expect(() => datingCopies("x", words, { setup, install: { ...inst, calendars: { ...inst.calendars, OTHER: { term: "closing" } } } })).toThrow(/a closing calendar books "the default closing type"/);
    expect(() => datingCopies("x", words, { setup: { ...setup, booked: [...setup.booked, { workflow: "w", name: "W", callType: "Nowhere", salesCallType: "closing" }] }, install: inst })).toThrow(/no calendar of the install books "Nowhere"/);
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
