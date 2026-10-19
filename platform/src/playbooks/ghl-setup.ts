/**
 * D175: what a playbook needs in a client's GHL, as a setup the additive provisioner reads (src/adapters/ghl/provision.ts: it
 * creates only what is missing, never renames, retypes or deletes). Dating's setup was written by hand
 * (installs/dating/ghl-setup.json, built and verified on RapidCloser); this builds the same shape for any offer from a few
 * params, and the test holds the two-board build with Dating's params to Dating's file. The calendars are not here: research
 * maps the client's own (D173). The application's own fields (a Typeform's answers, D122) are not here either: they follow the
 * form, not the process.
 */
import type { Setup } from "@/adapters/ghl/provision";
import type { OneBoardParams } from "./one-board";

export type SetupParams = {
  /** in front of every pipeline and field name; "" in a GHL account of the client's own, the offer's name + " – " in a shared one */
  prefix: string;
  /** the custom objects' key and label prefix ("dating_", "Dating "); "" and "" in an account of its own */
  objectKey: string; objectLabel: string;
  timezone: string;
  /** each closer's option on the Sales Call's Closer field, by email (D118) */
  closerOptions: Record<string, string>;
  /** the Sales Call's Primary Objection options and Call Type options */
  objections: string[]; callTypes: { key: string; label?: string }[];
};
/** An offer's objections until it names its own: Dating's, the templates' list without Hair's own (medical, burned before). */
export const OBJECTIONS = ["price", "partner", "timing", "fear", "competitor", "think_about_it"];

const opt = (key: string, label?: string) => ({ key, label: label ?? key.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") });
const field = (key: string, name: string, type: string, options?: { key: string; label: string }[]) => ({ key, name, type, ...(options ? { options } : {}) });

const CORE_CONTACT = [
  ["appointment_date", "Appointment Date", "DATE"], ["setter", "Setter", "TEXT"], ["cash_collected", "Cash Collected", "NUMERICAL"], ["revenue_generated", "Revenue Generated", "NUMERICAL"],
  ["utm_source", "UTM Source", "TEXT"], ["utm_medium", "UTM Medium", "TEXT"], ["utm_campaign", "UTM Campaign", "TEXT"], ["utm_content", "UTM Content", "TEXT"], ["utm_term", "UTM Term", "TEXT"], ["fbclid", "fbclid", "TEXT"],
].map(([binding, name, type]) => ({ binding, name, type }));

/** The three records every offer keeps: a Sales Call per booked call, a Payment, a Discovery Call per setter dial. */
function objects(p: SetupParams, payment?: { key: string; label: string; plural: string }) {
  const closer = [...new Set(Object.values(p.closerOptions))].map((k) => opt(k));
  const primary = { key: "display_label", name: "Display Label" };
  return [
    { binding: "sales_call", key: `custom_objects.${p.objectKey}sales_call`, label: `${p.objectLabel}Sales Call`, plural: `${p.objectLabel}Sales Calls`, primary, fields: [
      field("external_id", "External ID", "TEXT"), field("contact_id", "Contact ID", "TEXT"), field("opportunity_id", "Opportunity ID", "TEXT"), field("scheduled_at", "Scheduled At", "TEXT"), field("call_date", "Call Date", "DATE"),
      field("closer", "Closer", "SINGLE_OPTIONS", closer), field("setter", "Setter", "TEXT"),
      field("outcome", "Outcome", "SINGLE_OPTIONS", ["scheduled", "showed", "no_show", "cancelled", "rescheduled"].map((k) => opt(k, k === "no_show" ? "No Show" : undefined))),
      field("booking_source", "Booking Source", "SINGLE_OPTIONS", [opt("setter_set", "Setter Set"), opt("self_booked", "Self Booked")]),
      field("disposition", "Disposition", "SINGLE_OPTIONS", [opt("closed_won", "Closed Won"), opt("deposit"), opt("follow_up", "Follow Up"), opt("lost"), opt("dq", "DQ"), opt("no_offer", "No Offer"), opt("financing_denied", "Financing Denied"), opt("close_pending", "Close Pending")]),
      field("objection_primary", "Primary Objection", "SINGLE_OPTIONS", p.objections.map((k) => opt(k))),
      field("call_type", "Call Type", "SINGLE_OPTIONS", p.callTypes.map((c) => opt(c.key, c.label))),
      field("recording_url", "Recording URL", "TEXT"), field("transcript_ref", "Transcript", "TEXT"), field("duration_min", "Duration (min)", "NUMERICAL"),
      field("next_step", "Next Step", "LARGE_TEXT"), field("next_step_date", "Next Step Date", "DATE"), field("payment_terms", "Payment Terms", "TEXT"),
      field("cash_collected", "Cash Collected", "MONETORY"), field("contract_value", "Contract Value", "MONETORY"),
    ] },
    { binding: "payment", key: payment?.key ?? `custom_objects.${p.objectKey}payment`, label: payment?.label ?? `${p.objectLabel}Payment`, plural: payment?.plural ?? `${p.objectLabel}Payments`, primary, fields: [
      field("transaction_id", "Transaction ID", "TEXT"), field("amount", "Amount", "NUMERICAL"), field("occurred_at", "Occurred At", "TEXT"),
      field("type", "Type", "SINGLE_OPTIONS", ["deposit", "balance", "installment", "paid_in_full", "refund", "chargeback"].map((k) => opt(k))),
      field("status", "Status", "SINGLE_OPTIONS", ["succeeded", "failed", "refunded", "disputed", "pending"].map((k) => opt(k))),
      field("processor", "Processor", "TEXT"), field("contact_id", "Contact ID", "TEXT"), field("opportunity_id", "Opportunity ID", "TEXT"), field("closer", "Closer", "TEXT"), field("setter", "Setter", "TEXT"),
    ] },
    { binding: "discovery_call", key: `custom_objects.${p.objectKey}discovery${p.objectKey ? "" : "_call"}`, label: `${p.objectLabel}Discovery${p.objectKey ? "" : " Call"}`, plural: p.objectKey ? `${p.objectLabel}Discoveries` : `${p.objectLabel}Discovery Calls`, primary, fields: [
      field("external_id", "External ID", "TEXT"), field("contact_id", "Contact ID", "TEXT"), field("occurred_at", "Occurred At", "TEXT"), field("direction", "Direction", "TEXT"),
      field("duration_sec", "Duration (sec)", "NUMERICAL"), field("setter", "Setter", "TEXT"), field("outcome", "Outcome", "TEXT"), field("recording_url", "Recording URL", "TEXT"),
      field("call_result", "Call Result", "SINGLE_OPTIONS", [opt("set"), opt("follow_up", "Follow Up"), opt("dq", "DQ"), opt("not_interested", "Not Interested")]),
    ] },
  ];
}
const associations = (p: SetupParams) => {
  const k = (s: string) => `${p.objectKey}${s}`;
  return [
    { binding: "sales_call_contact", key: k("sales_call_contact"), first: "contact", second: "sales_call" },
    { binding: "sales_call_opportunity", key: k("sales_call_opportunity"), first: "sales_call", second: "opportunity" },
    { binding: "payment_contact", key: k("payment_contact"), first: "contact", second: "payment" },
    { binding: "payment_opportunity", key: k("payment_opportunity"), first: "payment", second: "opportunity" },
    { binding: "discovery_call_contact", key: p.objectKey ? `${p.objectKey}discovery_contact` : "discovery_call_contact", first: "contact", second: "discovery_call" },
  ];
};
/** What the setup hands the install: the Sales Call's and Discovery Call's option keys and what each means (D73, D79, D119). */
const install = (p: SetupParams) => ({
  salesCall: {
    outcomes: { scheduled: "scheduled", showed: "showed", no_show: "noshow", cancelled: "cancelled", rescheduled: "rescheduled" },
    bookingSources: { setter: "setter_set", self: "self_booked" },
    dispositions: { closed_won: "closed", deposit: "deposit", follow_up: "follow_up", lost: "lost", dq: "unqualified", no_offer: { meaning: "unqualified", reason: "No offer made (DQ before the pitch)" }, financing_denied: { meaning: "lost", reason: "Financing denied" }, close_pending: "pending" },
    dqDispositions: ["dq", "no_offer"], closerOptions: p.closerOptions,
  },
  discoveryCall: { results: { set: "set", follow_up: "follow_up", dq: "dq", not_interested: "not_interested" } },
});
const base = (p: SetupParams) => ({ prefix: p.prefix, timezone: p.timezone, team: [] as string[], hours: { days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" }, calendars: [] });

/** Two boards (Hair's and Dating's): a setter board from New Lead to the call, a closer board from the call to won. */
export function twoBoardSetup(p: SetupParams): Setup {
  return { ...base(p),
    pipelines: [
      { binding: "setter", name: "Setter Pipeline", stages: [["new_lead", "New Lead"], ["direct_booked", "Direct Booked"], ["appointment_set", "Appointment Set"], ["showed", "Showed"], ["cancelled", "Cancelled"], ["dq", "DQ"], ["not_interested", "Not Interested"]].map(([binding, name]) => ({ binding, name })) },
      { binding: "closer", name: "Closer Pipeline", stages: [["scheduled", "Scheduled"], ["cancelled", "Cancelled / No Show"], ["follow_up", "Follow Up"], ["deposit", "Deposit"], ["agreement_sent", "Agreement Sent"], ["closed_won", "Closed Won"], ["lost", "Lost"], ["disqualified", "Disqualified"]].map(([binding, name]) => ({ binding, name })) },
    ],
    contactFields: CORE_CONTACT, opportunityFields: [{ binding: "setter_owner", name: "Setter Owner", type: "TEXT" }, { binding: "stage_entered", name: "Stage Entered", type: "DATE" }],
    objects: objects(p), associations: associations(p), install: install(p) };
}

/** One board (PMU's): the closer board carries the whole journey, its stages named as the offer names them (its params). */
export function oneBoardSetup(p: SetupParams, ob: Pick<OneBoardParams, "board" | "stages" | "paymentObject">): Setup {
  const S = ob.stages;
  const stages: [string, string][] = [["new_lead", S.newLead], ["scheduled", S.booked], ["unresponsive", S.unresponsive], ["confirmed", S.confirmed], ["rescheduled", S.rescheduled], ["no_show", S.noShow], ["cancelled", S.cancelled],
    ["follow_up", "Follow Up"], ["deposit", "Deposit"], ["purchase", S.purchase], ["closed_won", S.won], ["lost", "Lost"], ["disqualified", "DQ"]];
  const payKey = ob.paymentObject.replace(/^custom_objects\./, ""), payLabel = payKey.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return { ...base(p),
    pipelines: [{ binding: "closer", name: ob.board, stages: stages.map(([binding, name]) => ({ binding, name })) }],
    contactFields: CORE_CONTACT, opportunityFields: [{ binding: "setter_owner", name: "Setter Owner", type: "TEXT" }],
    objects: objects(p, { key: ob.paymentObject, label: payLabel, plural: `${payLabel}${payLabel.endsWith("s") ? "" : "s"}` }), associations: associations(p), install: install(p) };
}
