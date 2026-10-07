import "./_env";
/**
 * pnpm smoke — a client comes in, then books a call, through the real engine against the database in DATABASE_URL,
 * with fake CRM/booking/AI adapters (nothing external is touched). Installs a throwaway company "Smoke" in SHADOW with
 * every template on and Hair-shaped bindings, then narrates what happened: events, each run's steps, what would have
 * gone out, what the cards and tags look like. Re-runnable: the company is wiped first.
 * `--template <slug>` (repeatable) limits the install to those templates, e.g. the set a real company has.
 */
import { DateTime } from "luxon";
import { asOperator, db, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { emitEvent, dispatchEvent } from "@/engine/dispatch";
import { applyAppointment } from "@/engine/poll";
import { loadCompany } from "@/engine/context";
import { tick } from "@/engine/runner";
import { parseDefinition } from "@/engine/definition";
import { describeNode } from "@/engine/describe";
import { companyReadiness } from "@/engine/readiness";
import type { Adapters, AppointmentSnapshot, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
const apptStore = new Map<string, AppointmentSnapshot>();
const fake: Adapters = {
  read: { contactsChangedSince: async () => [], inboundSince: async () => [], callMedia: async () => null, opportunitiesSince: async () => [], getContact: async (_c, id) => ({ id, firstName: id, tags: [], customFields: {}, dateUpdated: new Date().toISOString(), dateAdded: new Date().toISOString() }), listUsers: async () => [{ id: "U-JAMES", name: "James Closer", email: "james@saveyourhairtoday.com" }] },
  booking: (() => { const b: BookingRead = { appointmentsInWindow: async () => [], getAppointment: async (_c, id) => apptStore.get(id) ?? null, listCalendars: async () => [{ id: "EVT-SELF", name: "45 Min Strategy Call", teamMemberIds: ["U-JAMES"], bookingUrl: "https://calendly.com/hair/45min" }, { id: "EVT-SETTER", name: "45 Min Strategy Call - S", teamMemberIds: ["U-JAMES"], bookingUrl: "https://calendly.com/hair/45min-s" }] }; return { ghl: b, calendly: b }; })(),
  write: { createContact: async () => ({ id: "x" }), addTag: async () => {}, removeTag: async () => {}, addNote: async () => {}, updateAppointment: async () => {}, updateContact: async () => {}, createTask: async () => ({ id: "t" }), createRecord: async () => ({ id: "rec" }), updateRecord: async () => {}, relateRecords: async () => {}, createOpportunity: async () => ({ id: "ghl-opp" }), updateOpportunity: async () => {} },
  sender: { sendSms: async () => ({ externalId: "s", accepted: true }), sendEmail: async () => ({ externalId: "e", accepted: true }), deliveryStatus: async () => ({ status: "sent" }) },
  classifier: { choice: async () => ({ value: "confirmed", confidence: 0.95, distribution: { confirmed: 0.95 }, unclear: false }) },
  notifier: { post: async () => ({ ts: "1" }) },
  analyst: { analyze: async () => ({ text: "{}", parsed: {}, model: "fake", usage: { input: 0, output: 0, cacheRead: 0 } }) },
};
const args = process.argv.slice(2);
const onlyTemplates = args.map((a, i) => (a === "--template" ? args[i + 1] : null)).filter((x): x is string => !!x);
const out: string[] = [];
const say = (s = "") => out.push(s);
const fmt = (d: Date | string | null | undefined) => (d ? DateTime.fromJSDate(new Date(d)).setZone(TZ).toFormat("ccc LLL d, h:mm a") : "—");

async function narrateSince(companyId: string, contactId: string, sinceEventId: number, title: string) {
  say(`\n## ${title}\n`);
  const events = await asOperator((c) => many<{ id: number; event_type: string; source: string; data: Record<string, unknown>; run_id: string | null; workflow: string | null }>(c, "select e.id, e.event_type, e.source, e.data, e.run_id, w.name as workflow from events e left join workflows w on w.id::text = e.data->>'workflow_id' where e.company_id=$1 and (e.contact_id=$2 or e.contact_id is null) and e.id>$3 order by e.id", [companyId, contactId, sinceEventId]));
  say("**Events, in order**");
  for (const e of events) { const d = Object.entries(e.data).filter(([k, v]) => v !== undefined && v !== null && !["event_id", "ghl_contact_id", "workflow_id", "trigger_node"].includes(k)).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · "); say(`- \`${e.event_type}\` (${e.source})${e.workflow ? ` — ${e.workflow}` : ""}${d ? ` — ${d.slice(0, 160)}` : ""}`); }
  const runs = await asOperator((c) => many<{ id: string; name: string; status: string; exit_reason: string | null; current_node: string | null; next_run_at: Date | null; started_at: Date }>(c, "select r.id, w.name, r.status, r.exit_reason, r.current_node, r.next_run_at, r.started_at from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.contact_id=$2 and r.started_at > (select coalesce(max(occurred_at), '-infinity') from events where id<=$3 and company_id=$1) order by r.started_at", [companyId, contactId, sinceEventId]));
  for (const r of runs) {
    say(`\n**${r.name}** → ${r.status}${r.exit_reason ? ` (${r.exit_reason})` : ""}${r.status === "waiting" ? ` · wakes ${fmt(r.next_run_at)} at step ${r.current_node}` : ""}`);
    const def = await asOperator(async (c) => parseDefinition((await one<{ definition: unknown }>(c, "select v.definition from workflow_versions v join runs r on r.workflow_id=v.workflow_id and r.workflow_version=v.version where r.id=$1", [r.id]))!.definition));
    const steps = await asOperator((c) => many<{ node_id: string; status: string; result: Record<string, unknown>; error: string | null }>(c, "select node_id, status, result, error from run_steps where run_id=$1 order by started_at", [r.id]));
    for (const s of steps) {
      const n = def.nodes.find((x) => x.id === s.node_id); const d = n ? describeNode(n) : { title: s.node_id };
      const res = s.error ? `✗ ${s.error}` : s.result && Object.keys(s.result).length ? Object.entries(s.result).filter(([k]) => !["shadow"].includes(k)).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ").slice(0, 220) : "";
      say(`  - ${s.status === "ok" ? "✓" : s.status === "waiting" ? "⏳" : s.status === "skipped" ? "↷" : s.status === "failed" ? "✗" : "·"} ${d.title}${res ? ` — ${res}` : ""}`);
    }
    const sends = await asOperator((c) => many<{ channel: string; status: string; rendered_body: string; suppressed_reason: string | null }>(c, "select channel, status, rendered_body, suppressed_reason from sends where run_id=$1 order by scheduled_for", [r.id]));
    for (const sd of sends) if (sd.rendered_body) { say(`  > **${sd.channel}** (${sd.status}${sd.suppressed_reason ? `: ${sd.suppressed_reason}` : ""})`); for (const line of (sd.channel === "slack" ? sd.rendered_body : sd.rendered_body.replace(/<[^>]+>/g, " ")).replace(/\s+\n/g, "\n").trim().split("\n")) say(`  > ${line.trim()}`); }
  }
  const cards = await asOperator((c) => many<{ name: string; ghl_pipeline_id: string; ghl_stage_id: string; status: string; owner: string | null }>(c, "select p.name, p.ghl_pipeline_id, p.ghl_stage_id, p.status, u.name as owner from pipeline_cards p left join users u on u.id=p.assigned_user_id where p.company_id=$1 and p.contact_id=$2 order by p.created_at", [companyId, contactId]));
  say(`\n**Pipeline cards now**: ${cards.length ? cards.map((k) => `${k.ghl_pipeline_id} → "${k.name}" @ ${k.ghl_stage_id} (${k.status}${k.owner ? `, ${k.owner}` : ""})`).join("; ") : "none"}`);
  const shadowTags = await asOperator((c) => many<{ event_type: string; tag: string }>(c, "select event_type, data->>'tag' as tag from events where company_id=$1 and contact_id=$2 and event_type in ('tag.added','tag.removed') order by id", [companyId, contactId]));
  say(`**Tags (would be)**: +${shadowTags.filter((t) => t.event_type === "tag.added").map((t) => t.tag).join(", +") || "none"}${shadowTags.some((t) => t.event_type === "tag.removed") ? ` · removed ${shadowTags.filter((t) => t.event_type === "tag.removed").map((t) => t.tag).join(", ")}` : ""}`);
}

(async () => {
  await migrate();
  await asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug='smoke'");
    if (co) { await c.query("delete from run_steps where run_id in (select id from runs where company_id=$1)", [co.id]); await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]); await c.query("update appointments set disposition_id=null where company_id=$1", [co.id]);
      for (const t of ["sends", "runs", "events", "workflow_triggers", "workflows", "messages", "crm_records", "webhook_deliveries", "payments", "recordings", "form_submissions", "forms", "appointments", "pipeline_cards", "opportunities", "calendars", "contact_identifiers", "intake", "contacts", "users", "company_terms", "bindings", "poll_cursors", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]); }
  });
  const inst = await installCompany({ name: "Smoke (synthetic)", slug: "smoke", timezone: TZ, locationId: "LOC-SMOKE", pit: "pit-fake", mode: "shadow", enable: true,
    calendars: { "EVT-SELF": { term: "closing", selfBooked: true }, "EVT-SETTER": { term: "closing", selfBooked: false } },
    crm: { pipeline_setter: "Setter board", pipeline_closer: "Closer board", stage_setter_new_lead: "New Lead, Not Booked", stage_setter_direct_booked: "Direct Booked Call", stage_setter_appointment_set: "Appointment Set", stage_closer_scheduled: "Scheduled", stage_setter_cancelled: "Cancelled (setter)", stage_closer_cancelled: "Cancelled (closer)", stage_setter_showed: "Showed",
      field_opportunity_stage_entered: "Stage Entered Date", field_opportunity_setter_owner: "Setter Owner", field_contact_appointment_date: "Appointment Date", field_contact_setter: "Setter", field_contact_hair_loss: "Hair Loss", field_contact_hair_loss_stage: "Hair Loss Stage", field_contact_noticing_for: "Noticing For", field_contact_commit_routine: "Commit Routine", field_contact_work_situation: "Work Situation",
      field_contact_cash_collected: "Cash Collected", field_contact_revenue_generated: "Revenue Generated", assoc_payment_contact: "payment↔contact", assoc_payment_opportunity: "payment↔opportunity", assoc_sales_call_contact: "call↔contact", assoc_sales_call_opportunity: "call↔opportunity" },
    contractValueDefault: 2999, anthropicKey: "sk-ant-fake", templates: onlyTemplates }, fake);
  const companyId = inst.companyId;
  await asOperator((c) => c.query("update runs set next_run_at = now() + interval '1 day' where company_id <> $1 and status in ('active','waiting')", [companyId]));   // park other companies' runs in this database
  say(`# Smoke journey — ${DateTime.now().setZone(TZ).toFormat("ccc LLL d yyyy, h:mm a ZZZZ")}\n`);
  say(`Company **Smoke (synthetic)** in **shadow**, ${onlyTemplates.length ? `templates ${onlyTemplates.join(", ")}` : `all ${inst.installed.length} templates`} on, fake adapters (no GHL, Calendly, Slack or Anthropic calls). Bindings are labelled with words instead of ids so the output reads.`);
  say(inst.installed.filter((s) => !s.endsWith("enabled")).length ? `Not enabled: ${inst.installed.filter((s) => !s.endsWith("enabled")).join("; ")}` : "Every template enabled.");

  // 1. a client comes in: the CRM poll sees a new contact with a phone, an intake form filled
  const contactId = await asOperator(async (c) => {
    const id = (await one<{ id: string }>(c, `insert into contacts (company_id, ghl_contact_id, first_name, last_name, timezone, ghl_fields) values ($1,'GHL-MIA','Mia','Ortiz',$2,$3) returning id`,
      [companyId, TZ, JSON.stringify({ "Hair Loss": "Thinning", "Hair Loss Stage": "Stage 3", "Noticing For": "2 years", "Commit Routine": "Yes", "Work Situation": "Full time" })]))!.id;
    await c.query("insert into contact_identifiers (company_id, contact_id, kind, value) values ($1,$2,'email','mia@example.com'),($1,$2,'phone','+12125550123')", [companyId, id]);
    return id;
  });
  const mark0 = (await asOperator((c) => one<{ m: number }>(c, "select coalesce(max(id),0) as m from events")))!.m;
  await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: companyId, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "lead.created", source: "ghl_poll", data: { ghl_contact_id: "GHL-MIA" } }), { contact: { id: contactId, ghl_contact_id: "GHL-MIA", tags: [] } }));
  await tick(fake);
  await narrateSince(companyId, contactId, mark0, "1. A client comes in — Mia Ortiz, new contact in the CRM with a phone number");

  // 2. two days later the setter books her on the closer's setter event type for Thursday 2pm; Calendly carries the setter's name, links and UTM
  const mark1 = (await asOperator((c) => one<{ m: number }>(c, "select coalesce(max(id),0) as m from events")))!.m;
  const start = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
  const booking: AppointmentSnapshot = { id: "cal-evt-7781", calendarId: "EVT-SETTER", invitee: { email: "mia@example.com", phone: "+12125550123", firstName: "Mia", lastName: "Ortiz", timezone: TZ }, assignedUserEmail: "james@saveyourhairtoday.com", startTime: start.toISO()!, endTime: start.plus({ minutes: 45 }).toISO()!, status: "confirmed", dateAdded: new Date().toISOString(),
    setBy: "Luis", rescheduleUrl: "https://calendly.com/reschedulings/abc", cancelUrl: "https://calendly.com/cancellations/abc", tracking: { utm_source: "ig", utm_campaign: "oct-thinning" }, raw: {} };
  apptStore.set(booking.id, booking);
  await asOperator(async (c) => { const { row, adapterCompany } = await loadCompany(c, companyId); await applyAppointment(c, row, adapterCompany, fake, booking); });
  await tick(fake);
  await narrateSince(companyId, contactId, mark1, `2. The setter (Luis) books Mia a closing call with James for ${start.toFormat("cccc LLL d 'at' h:mm a")}`);

  // what is parked for later
  const parked = await asOperator((c) => many<{ name: string; next_run_at: Date; current_node: string }>(c, "select w.name, r.next_run_at, r.current_node from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and r.contact_id=$2 and r.status='waiting' order by r.next_run_at", [companyId, contactId]));
  say("\n## What is now waiting to happen\n");
  for (const p of parked) say(`- **${p.name}** wakes ${fmt(p.next_run_at)} (step ${p.current_node})`);
  const ready = await asOperator((c) => companyReadiness(c, companyId, "/c/smoke"));
  say("\n## Readiness of this synthetic company\n");
  for (const i of ready.issues) say(`- ${i.level === "blocker" ? "BLOCKS" : "note"}: ${i.text}`);
  console.log(out.join("\n"));
  await db().end();
})().catch((e) => { console.error(e); process.exit(1); });
