/** D266: a setter who books a closing call stops owning the person and follows them: the contact and both cards. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { applyAppointment } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { fakeAdapters, fakeProbes } from "@/engine/test-install";
import type { Adapters, AppointmentSnapshot } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/Phoenix", SLUG = `d266-${Date.now()}`;
const follows: { on: string; id: string; ids: string[] }[] = [], owners: { id: string; owner?: string }[] = [];
let refuse = false;
const base = fakeAdapters();
const fake: Adapters = { ...base,
  read: { ...base.read, openCards: async () => [], listUsers: async () => [{ id: "U1", name: "Sam Closer", email: "sam@x.com" }] },
  booking: (() => { const b = { appointmentsInWindow: async () => [], listCalendars: async () => [{ id: "CAL", name: "Closer Call", teamMemberIds: ["U1"] }], getAppointment: async (_c: unknown, id: string) => appts.get(id) ?? null }; return { ghl: b, calendly: b }; })(),
  write: { ...base.write,
    updateContact: async (_c, id, patch) => { if (patch.assignedUserId) owners.push({ id, owner: patch.assignedUserId }); },
    createOpportunity: async (_c, input) => ({ id: `opp-${input.pipelineId}-${input.contactId}` }),
    addFollowers: async (_c, on, id, ids) => { if (refuse) throw new Error("GHL 422 on /contacts/x/followers: user not found"); follows.push({ on, id, ids }); } } };
const CRM = { pipeline_setter: "PIPE-SETTER", pipeline_closer: "PIPE-CLOSER", stage_setter_new_lead: "STAGE-NEW", stage_setter_direct_booked: "STAGE-DIRECT", stage_setter_appointment_set: "STAGE-SET", stage_setter_showed: "STAGE-SHOWED", stage_setter_cancelled: "STAGE-S-CANCEL",
  stage_closer_scheduled: "STAGE-SCHED", stage_closer_agreement_sent: "STAGE-AGREE", stage_closer_closed_won: "STAGE-WON", stage_closer_cancelled: "STAGE-C-CANCEL", stage_closer_follow_up: "STAGE-FOLLOWUP", stage_closer_lost: "STAGE-LOST", stage_closer_disqualified: "STAGE-DQ",
  field_opportunity_stage_entered: "CF-STAGE-DATE", field_opportunity_setter_owner: "CF-SETTER-OWNER", field_contact_appointment_date: "CF-APPT-DATE", field_contact_setter: "CF-SETTER", field_contact_cash_collected: "CF-CASH", field_contact_revenue_generated: "CF-REV",
  assoc_discovery_call_contact: "ASSOC-DC", assoc_sales_call_contact: "ASSOC-SC", assoc_sales_call_opportunity: "ASSOC-SO", assoc_payment_contact: "ASSOC-PC", assoc_payment_opportunity: "ASSOC-PO", agreement_template: "TPL-AGREE", agreement_sender: "U1", default_closer: "U1" };
const SLACK = { bookings: "CBOOK", calls: "CCALLS", deals: "CDEALS", payments: "CPAY", alerts: "CALERTS", setter_calls: "CSET", eod: "CEOD", reports: "CREP" };
const appts = new Map<string, AppointmentSnapshot>();
let co = "";

const person = (ghl: string, first: string) => asOperator(async (c) => (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone) values ($1,$2,$3,'Lead',$4) returning id", [co, ghl, first, TZ]))!.id);
const book = async (id: string, ghl: string, setBy?: string) => {
  const start = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
  const s: AppointmentSnapshot = { id, calendarId: "CAL", contactId: ghl, assignedUserId: "U1", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(), meetingUrl: "https://zoom.us/j/1", raw: {}, ...(setBy ? { setBy } : {}) };
  appts.set(id, s);
  await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, co); await applyAppointment(c, row, adapterCompany, fake, s); });
  await tick(fake, undefined, co, fakeProbes);
};
const bookingSteps = (contactId: string) => asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown> }>(c, `select s.node_id, s.status, s.result from run_steps s join runs r on r.id=s.run_id join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id
  where r.company_id=$1 and r.contact_id=$2 and t.slug='call-booked' order by s.started_at`, [co, contactId]));

describe.skipIf(!process.env.DATABASE_URL)("D266: the setter follows the person they set", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Follows", slug: SLUG, timezone: TZ, locationId: "LOC", pit: "pit-fake", calendars: { CAL: "closing" }, setterRule: "question", closers: ["sam@x.com"], enable: true, crm: CRM, slack: SLACK, anthropicKey: "sk-fake", contractValueDefault: 2999 }, fake)).companyId;
    await asOperator(async (c) => {
      await c.query("update companies set mode='live' where id=$1", [co]);
      await c.query("insert into users (company_id, email, name, role, ghl_user_id) values ($1,'luis@x.com','Luis Setter','setter','U-LUIS')", [co]);
    });
  });

  it("set by Luis: Sam owns the contact; Luis follows the contact, the setter card and the closer card", async () => {
    const ct = await person("G-ANA", "Ana");
    await book("A-ANA", "G-ANA", "Luis Setter");
    expect(owners.filter((o) => o.id === "G-ANA").map((o) => o.owner)).toEqual(["U1"]);
    expect(follows.filter((f) => f.on === "contact")).toEqual([{ on: "contact", id: "G-ANA", ids: ["U-LUIS"] }]);
    expect(follows.filter((f) => f.on === "opportunity").map((f) => [f.id, f.ids]).sort()).toEqual([["opp-PIPE-CLOSER-G-ANA", ["U-LUIS"]], ["opp-PIPE-SETTER-G-ANA", ["U-LUIS"]]]);
    expect((await bookingSteps(ct)).find((s) => s.node_id === "b3")?.result).toMatchObject({ followers: ["U-LUIS"] });
  });

  it("self-booked: nobody follows", async () => {
    const n = follows.length;
    await person("G-BO", "Bo");
    await book("A-BO", "G-BO");
    expect(follows.slice(n)).toEqual([]);
  });

  it("set by the closer themself (a hybrid): they own it, so they are not also a follower", async () => {
    const n = follows.length;
    await person("G-CY", "Cy");
    await book("A-CY", "G-CY", "Sam Closer");
    expect(follows.slice(n)).toEqual([]);
  });

  it("the CRM refuses the follower: the booking still goes through, the step says why, and a warning is raised", async () => {
    refuse = true;
    const ct = await person("G-DEE", "Dee");
    await book("A-DEE", "G-DEE", "Luis Setter");
    refuse = false;
    const run = await asOperator((c) => one<{ status: string }>(c, "select r.status from runs r join workflows w on w.id=r.workflow_id join workflow_templates t on t.id=w.template_id where r.company_id=$1 and r.contact_id=$2 and t.slug='call-booked'", [co, ct]));
    expect(run).toMatchObject({ status: "completed" });
    const b3 = (await bookingSteps(ct)).find((s) => s.node_id === "b3")!;
    expect(b3).toMatchObject({ status: "ok", result: { followers_failed: expect.stringContaining("user not found") } });
    expect(await asOperator((c) => one(c, "select level from alerts where company_id=$1 and key like 'followers:%' and resolved_at is null", [co]))).toMatchObject({ level: "warning" });
  });
});
