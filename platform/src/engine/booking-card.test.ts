/** D104: the booking card's intake lines are the company's own; Hair's card, backfilled, reads byte for byte as it did. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, installTemplates, type InstallInput } from "./install";
import { buildContext, loadCompany, type RunRow } from "./context";
import { render } from "./template";
import { templates } from "@/templates";
import { exampleContext, nodeExamples } from "./example";
import { parseDefinition, type Definition } from "./definition";
import { BOOKING_CARD_KEY, HAIR_INTAKE, intakeLines, intakeProblem, intakeText, type IntakeLine } from "./booking-card";
import { fakeAdapters } from "./test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

/** Call booked's card as it shipped before D104, Hair's questions in it. */
const OLD_CARD = "*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>\n*Booked with:* {{appointment.closer.name | default:unassigned}}\n{{vars.setter_line}}\n*Appointment time:* {{appointment.starts_at | date_company}}\n*Phone:* {{contact.phone | default:—}}\n*Hair loss:* {{contact.fields.hair_loss | default:—}} {{contact.fields.hair_loss_stage | default:}}\n*Noticing for:* {{contact.fields.noticing_for | default:—}}\n*Commit to routine:* {{contact.fields.commit_routine | default:—}}\n*Work situation:* {{contact.fields.work_situation | default:—}}\n*Reschedule link:* {{appointment.reschedule_url | default:—}}\n*Source:* {{contact.source | default:—}} · {{vars.booking_kind}}";
const shipped = () => JSON.parse(JSON.stringify(templates.find((t) => t.slug === "call-booked")!.definition)) as Definition;
const card = (def: Definition) => { const n = def.nodes.find((x) => x.id === "n4"); if (n?.type !== "slack_post") throw new Error("no card"); return n.template; };
const oldDefinition = () => { const d = shipped(); (d.nodes.find((x) => x.id === "n4") as { template: string }).template = OLD_CARD; return d; };

const HAIR_FIELDS = { field_contact_hair_loss: "F-HL", field_contact_hair_loss_stage: "F-HLS", field_contact_noticing_for: "F-NF", field_contact_commit_routine: "F-CR", field_contact_work_situation: "F-WS" };
const base = (slug: string, extra: Partial<InstallInput> = {}): InstallInput => ({ name: slug, slug, timezone: "America/Phoenix", locationId: `LOC-${slug}`, pit: "fake-token", calendars: { CAL: "closing" }, templates: ["call-booked"], ...extra });

async function wipe(slug: string) {
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return;
    await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
    for (const t of ["runs", "events", "appointments", "contact_identifiers", "contacts", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
    await c.query("delete from companies where id=$1", [co.id]);
  });
}

/** A booked person, as the run that posts the card sees them: their CRM fields, their phone, their booking's answers. */
async function booked(c: PoolClient, companyId: string, key: string, ghlFields: Record<string, unknown>, answers: Record<string, unknown> = {}, phone: string | null = "+16025550101") {
  const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, ghl_fields) values ($1,$2,'Jane','Doe',$3) returning id", [companyId, `G-${key}`, ghlFields]))!.id;
  if (phone) await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'phone',$3)", [companyId, ct, phone]);
  const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' and is_default", [companyId]))!.id;
  const at = DateTime.fromISO("2026-10-20T14:00:00Z");
  const appt = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, appointment_term, starts_at, ends_at, booked_at, status, answers, reschedule_url) values ($1,$2,$3,$4,$5,$6,now(),'confirmed',$7,'https://example.com/r') returning id", [companyId, ct, `A-${key}`, term, at.toJSDate(), at.plus({ minutes: 45 }).toJSDate(), answers]))!.id;
  return { ct, appt };
}

/** What the card's step posts for that person under a given template, the way the executor renders it. */
async function postOf(c: PoolClient, companyId: string, who: { ct: string; appt: string }, template: string): Promise<string> {
  const { row, bindings } = await loadCompany(c, companyId);
  const run = { id: "00000000-0000-0000-0000-000000000000", company_id: companyId, contact_id: who.ct, appointment_id: who.appt, opportunity_id: null, context: { vars: { setter_line: "", booking_kind: "self-booked" } }, started_at: new Date() } as unknown as RunRow;
  const ctx = await buildContext(c, run, row, bindings);
  return render(template, ctx, { tz: row.timezone, companyTz: row.timezone });
}
const currentCard = (c: PoolClient, companyId: string) => one<{ definition: Definition }>(c, "select v.definition from workflows w join workflow_templates t on t.id=w.template_id join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and t.slug='call-booked'", [companyId]).then((r) => card(r!.definition));

describe.skipIf(!process.env.DATABASE_URL)("the booking card's intake lines (D104)", () => {
  let hair: string, other: string;
  beforeAll(async () => {
    await migrate();
    await wipe("cardhair"); await wipe("cardpmu");
    hair = (await installCompany(base("cardhair", { crm: HAIR_FIELDS }), fakeAdapters())).companyId;
    other = (await installCompany(base("cardpmu", { crm: { field_contact_ad_budget: "F-AD" } }), fakeAdapters())).companyId;
  });

  it("Hair's card after the upgrade and the backfill is byte for byte the card it posted before", async () => {
    // Hair as production has it before D104: an untouched copy of the old Call booked, and no booking card setting
    await asOperator(async (c) => {
      const wf = (await one<{ id: string }>(c, "select w.id from workflows w join workflow_templates t on t.id=w.template_id where w.company_id=$1 and t.slug='call-booked'", [hair]))!;
      await c.query("update workflow_versions set definition=$2 where workflow_id=$1", [wf.id, parseDefinition(oldDefinition())]);
      await c.query("update workflows set template_version=0, diverged=false where id=$1", [wf.id]);
      await c.query("delete from bindings where company_id=$1 and key=$2", [hair, BOOKING_CARD_KEY]);
    });
    const people = await asOperator(async (c) => [
      await booked(c, hair, "full", { "F-HL": "Noticeable thinning", "F-HLS": "Stage 3", "F-NF": "2 years", "F-CR": "Yes", "F-WS": "Full time" }),
      await booked(c, hair, "nostage", { "F-HL": ["Receding", "Crown"], "F-NF": "6 months", "F-WS": "Self-employed" }, {}, "+16025550102"),
      await booked(c, hair, "empty", {}, {}, null),
    ]);
    const before = await asOperator(async (c) => { expect(await currentCard(c, hair)).toBe(OLD_CARD); return Promise.all(people.map((p) => postOf(c, hair, p, OLD_CARD))); });
    expect(before[0]).toContain("*Hair loss:* Noticeable thinning Stage 3\n*Noticing for:* 2 years\n*Commit to routine:* Yes\n*Work situation:* Full time\n");
    expect(before[2]).toContain("*Phone:* —\n*Hair loss:* — \n*Noticing for:* —\n");

    // POST /api/admin/templates: the template half of install, the path that upgrades Hair's copy
    const out = await asOperator((c) => installTemplates(c, hair, ["call-booked"], { existed: true }));
    expect(out[0]).toMatch(/^call-booked → upgraded/);
    const after = await asOperator(async (c) => {
      const tpl = await currentCard(c, hair);
      expect(tpl).toBe(card(shipped()));
      expect(tpl).not.toMatch(/hair/i);
      return Promise.all(people.map((p) => postOf(c, hair, p, tpl)));
    });
    expect(after).toEqual(before);
    for (let i = 0; i < before.length; i++) expect(Buffer.from(after[i]).equals(Buffer.from(before[i]))).toBe(true);
    const set = await asOperator((c) => loadCompany(c, hair));
    expect(intakeLines(set.bindings)).toEqual(HAIR_INTAKE);
    expect(await asOperator((c) => one(c, "select 1 from audit_log where company_id=$1 and action='binding.set' and target_id=$2", [hair, BOOKING_CARD_KEY]))).toBeTruthy();
  });

  it("the migration backfills only a company that bound Hair's field, and never over a setting already written", async () => {
    await asOperator((c) => c.query("delete from bindings where company_id=$1 and key=$2", [hair, BOOKING_CARD_KEY]));
    const r = await migrate();
    expect(r.bookingCard).toContain(hair); expect(r.bookingCard).not.toContain(other);
    expect(intakeLines((await asOperator((c) => loadCompany(c, hair))).bindings)).toEqual(HAIR_INTAKE);
    await asOperator((c) => c.query("update bindings set value=convert_to('[]','UTF8') where company_id=$1 and key=$2", [hair, BOOKING_CARD_KEY]));
    expect((await migrate()).bookingCard).not.toContain(hair);
    expect((await asOperator((c) => loadCompany(c, hair))).bindings[BOOKING_CARD_KEY]).toBe("[]");
    await asOperator((c) => c.query("update bindings set value=convert_to($3,'UTF8') where company_id=$1 and key=$2", [hair, BOOKING_CARD_KEY, JSON.stringify(HAIR_INTAKE)]));
  });

  it("a company with its own lines gets them, from a CRM field or a booking answer; unset, the card has none and never Hair's", async () => {
    const who = await asOperator((c) => booked(c, other, "pmu", { "F-AD": "$3,000" }, { monthly_revenue: "$20k-$50k" }));
    const tpl = card(shipped());
    const unset = await asOperator((c) => postOf(c, other, who, tpl));
    expect(unset).toContain("*Phone:* +16025550101\n*Reschedule link:* https://example.com/r\n");
    expect(unset).not.toMatch(/hair|noticing|routine|work situation/i);

    await installCompany(base("cardpmu", { crm: { field_contact_ad_budget: "F-AD" }, bookingCard: { intake: [{ label: "Monthly revenue", answer: "monthly_revenue" }, { label: "Ad budget", field: "ad_budget" }, { label: "Goal", answer: "goal" }] } }), fakeAdapters());
    const own = await asOperator((c) => postOf(c, other, who, tpl));
    expect(own).toContain("*Phone:* +16025550101\n*Monthly revenue:* $20k-$50k\n*Ad budget:* $3,000\n*Goal:* —\n*Reschedule link:* https://example.com/r\n");
    expect(own).not.toMatch(/hair/i);
  });

  it("a tags line says the words for the tags the contact has (PMU's MQL / DQ from its Zap), — when none, and is refused when malformed", () => {
    const q: IntakeLine[] = [{ label: "Qualified", tags: { "meta booked call mql": "MQL", "meta booked call dq": "DQ" } }];
    expect(intakeText(q, {}, undefined, ["vsl a", "Meta Booked Call MQL"])).toBe("*Qualified:* MQL");
    expect(intakeText(q, {}, undefined, ["meta booked call mql", "meta booked call dq"])).toBe("*Qualified:* MQL, DQ");
    expect(intakeText(q, {}, undefined, [])).toBe("*Qualified:* —");
    expect(intakeProblem({ label: "Qualified", tags: {} })).toMatch(/tags maps each tag/);
    expect(intakeProblem({ label: "Qualified", tags: { mql: "MQL" }, field: "x" })).toMatch(/exactly one of field, answer or tags/);
  });

  it("install writes the setting, refuses a malformed one, and leaves it alone when omitted", async () => {
    const stored = async () => (await asOperator((c) => loadCompany(c, other))).bindings[BOOKING_CARD_KEY];
    await installCompany(base("cardpmu", { bookingCard: { intake: [{ label: " Monthly revenue ", answer: "monthly_revenue" }] } }), fakeAdapters());
    expect(JSON.parse(await stored())).toEqual([{ label: "Monthly revenue", answer: "monthly_revenue" }]);
    await expect(installCompany(base("cardpmu", { bookingCard: { intake: [{ label: "Both", field: "a", answer: "b" }] } }), fakeAdapters())).rejects.toThrow(/exactly one of field, answer or tags/);
    await expect(installCompany(base("cardpmu", { bookingCard: { intake: [{ label: "", field: "a" }] } }), fakeAdapters())).rejects.toThrow(/needs a label/);
    await installCompany(base("cardpmu"), fakeAdapters());
    expect(JSON.parse(await stored())).toEqual([{ label: "Monthly revenue", answer: "monthly_revenue" }]);
    await installCompany(base("cardpmu", { bookingCard: { intake: [] } }), fakeAdapters());
    expect(await stored()).toBe("[]");
  });

  it("the dashboard's example of the card shows the company's own labels, and no lines when none are set", () => {
    const n4 = shipped().nodes.find((x) => x.id === "n4")!;
    const ex = (bindings: Record<string, string>) => nodeExamples(n4, exampleContext({ name: "PMU", timezone: "America/New_York" }, bindings), "America/New_York")[0].example;
    const own = ex({ [BOOKING_CARD_KEY]: JSON.stringify([{ label: "Monthly revenue", answer: "monthly_revenue" }, { label: "Ad budget", field: "ad_budget" }]) });
    expect(own.exact).toBe(true);
    expect(own.text).toContain("*Phone:* +1 602 555 0101\n*Monthly revenue:* [monthly revenue]\n*Ad budget:* [ad budget]\n*Reschedule link:*");
    expect(own.text).not.toMatch(/hair|crown/i);
    const none = ex({});
    expect(none.text).toContain("*Phone:* +1 602 555 0101\n*Reschedule link:*");
    expect(none.text).not.toMatch(/hair|crown|\[/i);
    expect(ex({ [BOOKING_CARD_KEY]: JSON.stringify(HAIR_INTAKE) }).text).toContain("*Hair loss:* [hair loss] [hair loss stage]\n*Noticing for:* [noticing for]\n");
  });
});
