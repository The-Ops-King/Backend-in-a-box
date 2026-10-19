/**
 * D170: the one-board playbook (PMU's process): one closer board carries a person through the whole journey (New Lead → Booked
 * Call → Confirmed / Unresponsive → Rescheduled / Cancelled / No Show → Follow Up / Lost / DQ → Purchase → won); there is no
 * setter board. Who set a call comes from the booking. Calls are recorded, payments go on the company's own payment object,
 * and the agreement goes out on the first payment. What is the offer's own (the board's and stages' names, what makes a lead, the
 * card names, the call types, the objections, the Slack faces) is its params, never this file.
 * Was installs/pmu/build.py.
 */
import { after, asCopy, drop, load, node, RESCHEDULE, type Copy, type Node } from "./kit";

export type OneBoardParams = {
  /** whose copies these are, as the notes say it ("PMU") */
  name: string;
  /** the closer board's name and its stages' names, as the titles say them */
  board: string;
  stages: { newLead: string; booked: string; rescheduled: string; cancelled: string; noShow: string; confirmed: string; unresponsive: string; purchase: string; won: string };
  /** a lead is someone with a phone, or one of these tags (`label`: how a title says them, "a VSL tag") */
  lead: { tags: string[]; label: string };
  /** a booked card is named "<person> -- <name>" by how it was booked */
  cardNames: { self: string; setter: string };
  /** the format the Appointment Start Time field takes (Luxon), e.g. "MM-dd-yyyy HH:mm" */
  appointmentDateFormat: string;
  /** the Sales Call's call type: the calendar's call type → option key, `otherwise` for the rest; `title` names the choice */
  callTypes: { pick: Record<string, string>; otherwise: string; title: string };
  /** the Sales Call's Primary Objection options and the dispositions a recording may file */
  objections: string[];
  recordedDispositions: string[];
  /** the custom object a payment is recorded on */
  paymentObject: string;
  /** the faces the recording's Slack post rotates through */
  slackIcons: string[];
  /** D170 (main): closing call types that get no pre-call reminders, by name (PMU: "Follow-up call", a follow-up or a reschedule) */
  noPreCall?: string[];
};

const CLOSER = "{{crm.pipeline_closer}}";

export function oneBoardCopies(p: OneBoardParams): Copy[] {
  const S = p.stages, out: Copy[] = [];

  // New lead: a lead has a phone or one of the lead tags; the card starts on the board at New Lead
  let d = load("new-lead");
  Object.assign(node(d, "n1"), { when: { or: [{ exists: "contact.phone" }, ...p.lead.tags.map((t) => ({ has: ["{{contact.tags}}", t] }))] }, else_exit: "no_phone_or_vsl",
    title: `A lead has a phone number or ${p.lead.label} (${p.lead.tags.join(", ")})` });
  const n2 = node(d, "n2"); Object.assign(n2, { pipeline: CLOSER, stage: "{{crm.stage_closer_new_lead}}" }); delete n2.fields;
  out.push(asCopy("new-lead", d, `${p.name}: one board. The card starts on ${p.board} at ${S.newLead}; a lead has a phone or ${p.lead.label} (${p.lead.tags.join(" / ")}); no stage-entered field`));

  // Call booked: one card, one fork after the setter / self paths rejoin: a new booking names the card and puts it on Booked
  // Call; a reschedule moves it to Rescheduled only off a pre-call stage and keeps its name (D105). No UTM fields.
  d = load("call-booked");
  for (const id of ["u1", "s3", "b4"]) drop(d, id);
  // D105: cards from before the engine sit anywhere; one past the call (Follow Up, Lost, Purchase, won, DQ) is left alone
  const PRE_CALL = ["new_lead", "scheduled", "unresponsive", "confirmed", "no_show", "cancelled", "rescheduled"].map((s) => `{{crm.stage_closer_${s}}}`);
  drop(d, "s4"); drop(d, "b5");
  after(d, "s2b", { id: "s_suffix", type: "set_var", key: "card_suffix", value: p.cardNames.self });
  after(d, "b3", { id: "b_suffix", type: "set_var", key: "card_suffix", value: p.cardNames.setter });
  const k3In = d.edges.filter((e) => e.to === "k3");
  if (k3In.map((e) => e.from).sort().join() !== "b6,s5") throw new Error("Call booked's paths no longer meet at k3");
  for (const e of k3In) e.to = "f_card";
  const card = { type: "pipeline_card", pipeline: CLOSER, name: "{{contact.name}} -- {{vars.card_suffix}}", assign_to: "{{appointment.closer.ghl_user_id | default:}}",
    fields: [{ id: "{{crm.field_opportunity_setter_owner}}", value: "{{appointment.set_by | default:}}" }] };
  d.nodes.splice(d.nodes.findIndex((n) => n.id === "k3"), 0,
    { id: "f_card", type: "branch", title: "A new booking or a reschedule?" },
    { ...card, id: "c_new", title: `Card → ${S.booked}, named -- ${p.cardNames.setter} / -- ${p.cardNames.self}`, stage: "{{crm.stage_closer_scheduled}}" },
    { ...card, id: "c_rs", title: `Card → ${S.rescheduled}, if it is before the call (its name stays)`, stage: "{{crm.stage_closer_rescheduled}}", keep_name: true, from_stages: PRE_CALL });
  d.edges.push({ from: "f_card", to: "c_rs", label: "a reschedule", when: RESCHEDULE }, { from: "f_card", to: "c_new", label: "a new booking", else: true }, { from: "c_new", to: "k3" }, { from: "c_rs", to: "k3" });
  (node(d, "n1").fields as { value: string }[])[0].value = `{{appointment.starts_at | date_company:${p.appointmentDateFormat}}}`;
  Object.assign(node(d, "k4").properties as Record<string, string>, { call_type: "{{vars.call_type}}", closer: "{{appointment.closer.first_name | default: | lower}}" });
  after(d, "k3", { id: "v_type", type: "set_var", title: `${p.callTypes.title}: the call type the calendar books`, key: "call_type", value: "{{appointment.term.name}}", pick: p.callTypes.pick, else_value: p.callTypes.otherwise });
  // what belongs to one side sits on that side: the video task under a new booking, the old slot's Sales Call under a
  // reschedule (every reschedule carries the slot it left), so neither is a sometimes-step
  d.edges = d.edges.filter((e) => !["f_card", "k3", "k5", "v_type"].includes(e.from) && e.to !== "k3");
  d.edges.push({ from: "f_card", to: "c_rs", label: "a reschedule", when: RESCHEDULE }, { from: "f_card", to: "c_new", label: "a new booking", else: true },
    { from: "c_new", to: "k3" }, { from: "k3", to: "v_type" }, { from: "c_rs", to: "k5" }, { from: "k5", to: "v_type" }, { from: "v_type", to: "k4" });
  delete node(d, "k3").only_if; delete node(d, "k5").only_if;
  node(d, "k5").title = "The Sales Call for the old time: logged as rescheduled";
  node(d, "b3").title = "The setter goes on the contact";
  const k5 = d.nodes.splice(d.nodes.findIndex((n) => n.id === "k5"), 1)[0];
  d.nodes.splice(d.nodes.findIndex((n) => n.id === "k3") + 1, 0, k5);
  const typeWords = Object.keys(p.callTypes.pick).length ? `the Sales Call says ${[...new Set([p.callTypes.otherwise, ...Object.values(p.callTypes.pick)])].map(cap).join(" or ")}` : "";
  out.push(asCopy("call-booked", d, `${p.name}: one board, one card fork after the setter / self paths: a new booking puts the card on ${S.booked} named -- ${p.cardNames.self} or -- ${p.cardNames.setter}; a reschedule moves it to ${S.rescheduled} only off a pre-call stage and keeps its name; ${typeWords}; no UTM fields; Appointment Start Time in ${p.name}'s format (${p.appointmentDateFormat})`));

  // Call cancelled: the one card → Cancelled
  d = load("call-cancelled"); drop(d, "n1");
  out.push(asCopy("call-cancelled", d, `${p.name}: one board. No setter card; the card moves to ${S.cancelled}`));

  // Call outcome: no setter card; a no-show → No Show; the dispositions are the company's (its sales_call.dispositions, D119)
  d = load("call-outcome"); drop(d, "gn1"); drop(d, "sc1");
  Object.assign(node(d, "gn2"), { stage: "{{crm.stage_closer_no_show}}", title: `Card → ${S.noShow} (move only: they can rebook)` });
  out.push(asCopy("call-outcome", d, `${p.name}: one board. No setter card; a no-show moves the card to ${S.noShow}; a deposit is its own disposition (from ${p.name}'s sales_call.dispositions) and its card goes to Deposit once the board has that stage (D119)`));

  // Call recorded: no setter card to mark showed; the closer, disposition and objection in the company's option keys;
  // the CRM note is Tyler's four sections and the recording link, and the Slack post says the same
  d = load("call-recorded"); drop(d, "o3");
  Object.assign(node(d, "r1").properties as Record<string, string>, {
    closer: "{{recording.closer.first_name | default: | lower}}",
    disposition: `{{vars.outcome.disposition | oneof:${p.recordedDispositions.join(",")} | default:}}`,
    objection_primary: `{{vars.notes.primary_objection | oneof:${p.objections.join(",")} | default:}}`,
  });
  node(d, "n1").template = "CURRENT SITUATION: {{vars.notes.prospect_situation | default:—}}\n\n"
    + "PAINS: {{vars.notes.pain | join:\" \" | default:—}}\n\n"
    + "GOALS: {{vars.notes.desire | join:\" \" | default:—}}\n\n"
    + "OBJECTIONS: {{vars.notes.objections | each:\"{{item.objection}}\" | join:\", \" | default:None}}\n\n"
    + "Fathom recording: {{recording.share_url | default:—}}";
  const s1 = node(d, "s1");
  s1.template = "*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{vars.recording_line}}\n"
    + "{{vars.appt_line}}\n"
    + "*Closer:* {{recording.closer.name | default:unknown}} · {{vars.convo.total_min | default:?}} min{{vars.parts_line}}\n"
    + "*Outcome:* {{vars.outcome.disposition | words | default:unclear}}\n\n"
    + "*Current situation:* {{vars.notes.prospect_situation | default:—}}\n"
    + "*Pains:* {{vars.notes.pain | join:\" \" | default:—}}\n"
    + "*Goals:* {{vars.notes.desire | join:\" \" | default:—}}\n"
    + "*Objections:* {{vars.notes.objections | each:\"{{item.objection}}\" | join:\", \" | default:None}}\n"
    + "*Next step:* {{vars.notes.next_step | default:—}} {{vars.notes.next_step_date | date_company:ccc LLL d | prefix:by}}";
  (s1.as as Record<string, unknown>).icon = p.slackIcons;
  out.push(asCopy("call-recorded", d, `${p.name}: one board. No setter card to mark showed; the closer, disposition and objection in ${p.name}'s own dropdown keys; the GHL note is Tyler's four sections (current situation, pains, goals, objections) and the Fathom link, the Slack post says the same with his emoji, the scorecard only in the thread`));

  // Deal closed: the one card → won
  d = load("deal-closed"); drop(d, "p2");
  out.push(asCopy("deal-closed", d, `${p.name}: one board. The card moves to ${S.won}, won; no setter card`));

  // Payment recorded: the company's payment object; the card → Purchase
  d = load("payment-recorded");
  const n4 = node(d, "n4"); n4.object = p.paymentObject;
  Object.assign(n4.properties as Record<string, string>, { paid_date: "{{event.paid_at | date_company:yyyy-MM-dd}}", link_status: "{{contact.ghl_contact_id | default: | then:linked}}" });
  Object.assign(node(d, "a3"), { stage: "{{crm.stage_closer_purchase}}", title: `Card → ${S.purchase} (paid, agreement sent)` });
  out.push(asCopy("payment-recorded", d, `${p.name}: payments go on ${p.name}'s ${p.paymentObject.replace(/^custom_objects\./, "")} object; the card moves to ${S.purchase} when the agreement goes out`));

  // Pre-call sequence: the card follows the confirmation
  d = load("pre-call-sequence");
  if (p.noPreCall?.length) for (const t of ["t1", "t2"]) (node(d, t) as Node & { match?: unknown }).match = { and: [{ eq: ["{{appointment.term.category}}", "closing"] }, ...p.noPreCall.map((n) => ({ neq: ["{{appointment.term.name}}", n] }))] };
  const follow = (id: string, title: string, stage: string): Node => ({ id, type: "pipeline_card", title, pipeline: CLOSER, stage, if_missing: "skip", pick: "latest" });
  after(d, "n_conf", follow("k_conf", `Card → ${S.confirmed}`, "{{crm.stage_closer_confirmed}}"));
  after(d, "n_unc", follow("k_unc", `No reply in 4 hours: card → ${S.unresponsive}`, "{{crm.stage_closer_unresponsive}}"));
  out.push(asCopy("pre-call-sequence", d, `${p.name}: the card follows the confirmation: ${S.confirmed} when they confirm, ${S.unresponsive} when there is no reply in 4 hours`));

  // Card moved: the board's no-show stage
  d = load("card-moved");
  const e = d.edges.find((x) => x.from === "b1" && x.to === "o_noshow");
  if (!e) throw new Error("Card moved has no b1 → o_noshow way");
  const all = (e.when as { and: unknown[] }).and;
  all[all.length - 1] = { and: [{ eq: ["{{event.pipeline}}", "closer"] }, { eq: ["{{event.to_stage}}", "{{crm.stage_closer_no_show | default:}}"] }] };
  out.push(asCopy("card-moved", d, `${p.name}: a card moved by hand into ${S.noShow} after the call started files a no-show`));
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
