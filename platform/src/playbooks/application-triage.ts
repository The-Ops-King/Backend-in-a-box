/**
 * D118: a dating company's own copies of the shipped templates, built from the templates and the company's words file
 * (installs/<company>/words.json), the way installs/pmu/build.py builds PMU's. Only what is the company's own is copied:
 * Deal closed (the welcome email and text) and Setter call logged (why a setter DQs a lead). Everything generic (the
 * company's objects, the closer's option key, the objections) the templates read from the company's settings, so every
 * other workflow stays the template's and keeps getting its upgrades.
 *
 * D123: the company's own workflows too, from installs/<company>/copies.json and its install file: one booked-call workflow per
 * call type its calendars book (built from Call booked, its trigger held to that call type; together they take Call booked's
 * place for the company), and New from Typeform (the scope tag and New lead for an applicant, on form.submitted).
 *
 * Words still marked [placeholder] keep their sends from going out: each such send is skipped ("only if there is a welcome
 * copy written", which nothing sets) until the words are the company's and the copies are built again.
 * Build: pnpm exec tsx scripts/build-copies.ts dating-nelly (--check: say whether the files are current, write nothing).
 * D170: this is the application-and-triage playbook (two boards, an application form, a triage call, a booked-call workflow per
 * call type); it was installs/dating/copies.ts.
 */
import { after, drop, load, node, RESCHEDULE, template, type Copy, type Def, type Edge } from "./kit";
import { defaultPrompts } from "@/prompts";
import { isPlaceholderCopy } from "@/engine/readiness";

export type DatingWords = {
  welcome: { subject: string; email: string; sms: string };
  /** a3's meaning of a DQ, and a4's words for each DQ reason (D154: the dating_dq_reason options, DATING_DQ_REASONS) */
  setterDq: { result: string; reasons: Record<string, string> };
  /** D154: a1's meaning of a setting call, in the company's words (a booked triage call counts) */
  setterCall?: { setting: string };
  /** D155: the pre-call texts, in the company's voice: a triage call's and a closing call's booking text and reminders */
  preCall?: { triage: PreCallWords; closing: PreCallWords };
};
/** D155: the booking text, the reminder a day before and the one an hour before; `hourNoLink` (D186): the hour-before text when the booking has no meeting link */
export type PreCallWords = { booked: string; day: string; hour: string; hourNoLink?: string };
/**
 * D123: `booked`, one per call type a calendar of the install books (its `calendars[…].name`): the workflow's file and name, the
 * Sales Call's `call_type` option it writes, and any tags a booking of that type adds. `fromForm`: the applicant workflow.
 */
export type DatingSetup = {
  /** `record` (D142): the call's record, a Sales Call (`sales`, the default, with `salesCallType`) or, for a triage call, a Discovery Call (`discovery`: no Sales Call, no closer card); `card`: the Slack card's words for the call ("triage call") */
  booked: { workflow: string; name: string; callType: string; salesCallType?: string; record?: "sales" | "discovery"; card?: string; tags?: string[] }[];
  fromForm?: { workflow: string; name: string };
  /** D142: a triage call's cancel (Call cancelled takes closing calls only): its own workflow for that call type */
  triageCancelled?: { workflow: string; name: string; callType: string };
  /** D143: a triage call's filed outcome (Call outcome filed takes closing calls only) */
  triageFiled?: { workflow: string; name: string; callType: string };
  /** D154: Setter call logged reads and posts only; the end of day writes the Discovery Call record and moves the setter card */
  setterCallReadOnly?: boolean;
  /** D156: an outbound call's answer on the end of day (setter_call.filed): its own workflow */
  setterFiled?: { workflow: string; name: string };
};
type InstallBits = { scopeTag?: string; calendars?: Record<string, string | { term: string; name?: string }> };

const DQ_REASONS = ["budget", "age", "geo", "medical", "timeline", "no_problem", "competitor", "bad_contact", "other"];
/** D154: why a dating lead is a DQ (Tyler, 2026-10-19), the dating_dq_reason options Jev reads into and the end of day asks */
export const DATING_DQ_REASONS = ["budget", "not_ready", "in_relationship", "casual", "bad_contact", "other"];
/** A send that must not go out while its words are a placeholder: nothing sets vars.welcome_copy_written. */
const HELD = { exists: "vars.welcome_copy_written" };

export function datingCopies(company: string, words: DatingWords, own?: { setup: DatingSetup; install: InstallBits }): Copy[] {
  const out: Copy[] = [];

  // Deal closed: the company's welcome email and text instead of Hair's
  const dc = load("deal-closed");
  const e1 = node(dc, "e1"), e2 = node(dc, "e2");
  const held = [words.welcome.subject, words.welcome.email, words.welcome.sms].some(isPlaceholderCopy);
  Object.assign(e1, { subject: words.welcome.subject, template: words.welcome.email, title: held ? "Welcome email [placeholder: the words are not written yet, so it is skipped]" : "Welcome email" });
  Object.assign(e2, { template: words.welcome.sms, title: held ? "Welcome text [placeholder: the words are not written yet, so it is skipped]" : "Welcome text" });
  if (held) { e1.only_if = HELD; e2.only_if = HELD; }
  // D130: the won closer card carries what the deal is worth (the opportunity's contract value, else the program price); the cash is the Sales Call's
  node(dc, "p1").value = "{{contact.revenue}}";
  out.push({ workflow: "deal-closed", definition: dc as unknown as Record<string, unknown>,
    note: `${company}: the welcome email and text are the company's own (installs/${company}/words.json)${held ? "; still placeholders, so both are skipped" : ""}, not Hair's (D118); the won closer card carries the deal's value (D130)` });

  // Setter call logged: why a setter DQs a lead, in the company's words; D154: it reads and posts, the end of day writes
  const scl = load("setter-call-logged");
  // the reasons are the template's (setter_dq_reason) or, D154, the dating ones (dating_dq_reason): whichever set the words name, all of it
  const keys = Object.keys(words.setterDq.reasons).sort().join();
  const domain = keys === [...DATING_DQ_REASONS].sort().join() ? "dating_dq_reason" : "setter_dq_reason";
  const list = domain === "dating_dq_reason" ? DATING_DQ_REASONS : DQ_REASONS;
  if (list.some((r) => !words.setterDq.reasons[r]?.trim()) || Object.keys(words.setterDq.reasons).length !== list.length) throw new Error(`setterDq.reasons needs words for each of ${DQ_REASONS.join(", ")}, or of ${DATING_DQ_REASONS.join(", ")}`);
  const a1 = node(scl, "a1"), a3 = node(scl, "a3"), a4 = node(scl, "a4");
  if (words.setterCall?.setting) (a1.criteria as Record<string, string>).setting = words.setterCall.setting;
  (a3.criteria as Record<string, string>).dq = words.setterDq.result;
  if (domain !== a4.domain) a4.domain = domain;
  a4.criteria = Object.fromEntries(list.map((r) => [r, words.setterDq.reasons[r]]));
  const dqHeld = [words.setterDq.result, ...Object.values(words.setterDq.reasons)].some(isPlaceholderCopy);
  if (dqHeld) a4.title = "Jev: why disqualified? [placeholder: the company's DQ reasons are not written yet]";
  const readOnly = !!own?.setup.setterCallReadOnly;
  if (readOnly) readOnlySetterCall(scl);
  out.push({ workflow: "setter-call-logged", definition: scl as unknown as Record<string, unknown>,
    note: `${company}: why a setter DQs a lead, in the company's words (installs/${company}/words.json)${dqHeld ? "; still placeholders" : ""}, not Hair's (D118)${readOnly ? "; a setting call's read is posted and logged for the end of day, which writes the Discovery Call record and moves the setter card: nothing written to the CRM here, no question to the team (D154)" : ""}` });
  if (words.preCall) out.push(...preCallCopies(words.preCall));
  if (own) out.push(...ownWorkflows(company, own.setup, own.install));
  return out;
}


/**
 * D154 (Tyler: "the setter call log shouldn't change things in HighLevel ... the setter end of day should"): Setter call logged
 * reads the call (Jev's call type, result and DQ reason, the notes), posts it in the setter channel and logs the read
 * (setter_call.result) for the end of day to pre-fill; Set by a booking through a setter's link still counts. Taken out: the
 * Discovery Call record and the note (r1, r_late, m1), the question to the team and its answer (b_ask on), the actions behind
 * setter_result.act (the task, the DQ tag, the lost cards) and the variables only they read.
 */
function readOnlySetterCall(d: Def) {
  for (const id of ["v_dqtag", "v_due", "v_mode", "v_key", "v_act", "v_ask", "r1", "m1", "lt_key", "lt_act", "r_late"]) drop(d, id);
  // b_ask and everything only it leads to: the run ends where the team would have been asked
  const gone = new Set<string>(["b_ask"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of d.edges) if (gone.has(e.from) && !gone.has(e.to) && d.edges.filter((x) => x.to === e.to).every((x) => gone.has(x.from))) { gone.add(e.to); grew = true; }
  }
  gone.delete("x1");
  for (const e of d.edges) if (e.to === "b_ask") e.to = "x1";
  d.edges = d.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  d.nodes = d.nodes.filter((n) => !gone.has(n.id));
  for (const id of ["s1", "s_late"]) { const n = node(d, id); n.template = String(n.template).replace("{{vars.act_line | line}}", ""); }
  Object.assign(node(d, "v_line"), { else_value: "{{vars.unsure_line}}; the end of day asks" });
  node(d, "v_by").title = "Without a booking, Jev's read (a Set read with no booking is left to the end of day)";
  // what the end of day pre-fills from (D156): the call type, the DQ reason's list, the write-up
  const a4 = node(d, "a4");
  for (const id of ["rec_read", "rec_late"]) { const rec = node(d, id); rec.data = { ...(rec.data as Record<string, unknown>), call_type: "{{vars.classify.call_type}}", dq_domain: a4.domain, digest: "{{vars.notes.digest | default:}}" }; }
  const left = JSON.stringify(d.nodes);
  for (const w of ["crm_record", "\"note\"", "create_task", "pipeline_card", "\"tags\"", "vars.act_line", "vars.asking"]) if (left.includes(w)) throw new Error(`Setter call logged still has ${w} after D154`);
}

/**
 * D155 (Tyler, 2026-10-19: one number, Nelly's, "all from Nelly"): the pre-call texts per call type, each its own copy of the
 * Pre-call sequence held to that call type (a triage call is not a closing call, so the template would never take it): the
 * booking text with its reply handling (confirm, cancel, reschedule, the closer asked when Jev is unsure), then the text a day
 * before and the one an hour before. Taken out: the day-one and 24-hour emails, the 3- and 2-day texts, the morning-of and
 * 10-minute texts, and the rebooking text (Tyler: "we'll do it manually ... the emoji in Slack is just a confirmation of what
 * happened"): 🔁 says in the booking thread who is moving the call; the closer sends the new time.
 */
const PRE_CALL = [
  { key: "triage" as const, workflow: "triage-pre-call", name: "Triage pre-call", callType: "Triage call", card: "strategy call" },
  { key: "closing" as const, workflow: "closing-pre-call", name: "Closing pre-call", callType: "Closing call", card: "consultation" },
];
function preCallCopies(words: { triage: PreCallWords; closing: PreCallWords }): Copy[] {
  const pc = template("pre-call-sequence");
  return PRE_CALL.map((t) => {
    const w = words[t.key];
    for (const k of ["booked", "day", "hour"] as const) if (!w?.[k]?.trim()) throw new Error(`words.preCall.${t.key}.${k} is empty`);
    const d = load("pre-call-sequence");
    const isType = { eq: ["{{appointment.term.name}}", t.callType] };
    Object.assign(node(d, "t1"), { match: isType, title: `A ${t.callType} booked` });
    Object.assign(node(d, "t2"), { match: isType, title: `A ${t.callType} moved` });
    for (const id of ["e1", "r72", "m72", "r48", "m48", "m24e", "mm", "r10", "m10", "n_rs"]) drop(d, id);
    // the morning-of fork: its wait and branch go, so the day-before text leads straight to the hour-before wait
    for (const e of d.edges) if (e.to === "rm") e.to = "r1";
    d.edges = d.edges.filter((e) => e.from !== "rm" && e.from !== "bm");
    d.nodes = d.nodes.filter((n) => n.id !== "rm" && n.id !== "bm");
    Object.assign(node(d, "s1"), { template: w.booked, title: "Booking text" });
    Object.assign(node(d, "m24s"), { template: w.day, title: "The day before" });
    Object.assign(node(d, "m1"), { template: w.hour, title: "An hour before" });
    Object.assign(node(d, "n_rs_slack"), { template: "🔁 {{contact.first_name}} wants a new time: moving the call by hand.\n> {{reply.inbound_since_send}}{{reaction.user_name | line:Decided by}}", title: "React 🔁, note who is moving it (by hand)" });
    // D186: the keep / cancel / reschedule ask goes to the booking channel, and 🔁 sends nothing (the call is moved by hand)
    const ask = node(d, "n_ask");
    const offer = "Tap ✅ keep the call, ❌ cancel it, 🔁 reschedule (they get the rebooking link).";
    if (!String(ask.template).includes(offer)) throw new Error(`${t.name}: the ask no longer offers the rebooking link`);
    // a reply can come when no text of ours went out (refused, DND): the ask says so instead of failing on the missing text
    const sent = "> {{reply.last_outbound.body}}";
    if (!String(ask.template).includes(sent)) throw new Error(`${t.name}: the ask no longer quotes what we sent`);
    Object.assign(ask, { channel: "{{slack.channel.bookings}}", template: String(ask.template).replace(offer, "Tap ✅ keep the call, ❌ cancel it, 🔁 reschedule (move it by hand; no text goes out).").replace(sent, "> {{reply.last_outbound.body | default:nothing yet: our booking text didn't go out}}"), title: "Ask in the booking channel: keep, cancel or reschedule?" });
    // D186: a booking with no meeting link is said at once in the channel the company names (slack.channel.no_link), the closer
    // tagged; the hour-before text then leaves the link line out
    if (w.hourNoLink !== undefined) {
      if (!w.hourNoLink.trim()) throw new Error(`words.preCall.${t.key}.hourNoLink is empty`);
      if (!w.hour.includes("{{appointment.meeting_url}}")) throw new Error(`words.preCall.${t.key}: hourNoLink without a link in the hour text`);
      const noLink = { not: { exists: "appointment.meeting_url" } };
      const said = `{{appointment.closer.mention | default:Heads up}}: {{contact.name | default:A contact}}'s ${t.card} {{appointment.starts_at | date_company}} has no meeting link in Calendly. Please send them the link.`;
      // Tyler: "let's have no-link alert to go to sales booked and alert": one post in each, each channel its own setting
      after(d, "c0", { id: "n_nolink", type: "slack_post", channel: "{{slack.channel.no_link}}", only_if: noLink, as: { name: "No meeting link", icon: ":link:" }, template: said, title: "No meeting link: tell the closer in the booking channel" });
      after(d, "n_nolink", { id: "n_nolink_alert", type: "slack_post", channel: "{{slack.channel.no_link_alerts}}", only_if: noLink, as: { name: "No meeting link", icon: ":link:" }, template: said, title: "No meeting link: and in the alerts channel" });
      node(d, "m1").only_if = { exists: "appointment.meeting_url" };
      after(d, "m1", { id: "m1_nolink", type: "send_sms", template: w.hourNoLink, validity: node(d, "m1").validity, on_stale: "skip", only_if: noLink, title: "An hour before, no link yet" });
    }
    // D193: the reminders before an evening call go earlier the same day, not the next morning (when it is too late to send them)
    for (const id of ["r24", "r1"]) (node(d, id).rule as Record<string, unknown>).window = "before";
    // D194: a booking close to its call: no "no reply in 4 hours" note when the wait was cut short by the call, and no hour-before
    // text right on the heels of the booking text
    node(d, "n_unc_slack").only_if = { gt: ["{{appointment.starts_at | hours_until}}", 1.5] };
    const notJustSent = { or: [{ not: { exists: "reply.last_outbound.at" } }, { lt: ["{{reply.last_outbound.at | hours_until}}", -1] }] };
    for (const id of ["m1", "m1_nolink"]) { const m = d.nodes.find((n) => n.id === id); if (m) m.only_if = m.only_if ? { and: [m.only_if, notJustSent] } : notJustSent; }
    const left = JSON.stringify(d.nodes);
    if (left.includes("send_email") || left.includes("[placeholder") || d.nodes.filter((n) => n.type === "send_sms").length !== (w.hourNoLink !== undefined ? 4 : 3)) throw new Error(`${t.name}: a send of the template is left unwritten`);
    return { workflow: t.workflow, name: t.name, create: { stage: pc.stage, sort: pc.sort + (t.key === "triage" ? 0 : 1), takesOver: "pre-call-sequence" }, definition: d as unknown as Record<string, unknown>,
      note: `the ${t.callType}'s pre-call texts, all from Nelly (D155): the booking text with its reply handling, a day before and an hour before; no emails; no rebooking text (a reschedule is moved by hand, 🔁 notes who)` };
  });
}

/**
 * D123/D105/D107: Call booked with one card fork after the setter and self paths rejoin, the way PMU's copy has it ("A new booking
 * or a reschedule?"), on the two boards of the Hair model: each path keeps what says how the call was booked (the remembered
 * values, the setter on the contact, the setter card, the tags), and the closer card moves in the fork. A new booking puts it on
 * Scheduled, named -- Direct / -- Setter Booked, then the video task; a reschedule moves it to Scheduled only off a pre-call stage
 * (Scheduled, Cancelled / No Show; her board has no Rescheduled stage) keeping its name, then logs the old slot's Sales Call as
 * rescheduled. Both rejoin at the Sales Call record. Dropped from the template: s4 and b5 (the closer card in each path, now the
 * fork's c_new / c_rs) and k3's and k5's "only if" (the fork's ways say it); nothing else.
 */
function bookedWithFork(): Def {
  const d = load("call-booked");
  for (const id of ["s4", "b5"]) drop(d, id);
  after(d, "s2b", { id: "s_suffix", type: "set_var", key: "card_suffix", value: "Direct" });
  after(d, "b2b", { id: "b_suffix", type: "set_var", key: "card_suffix", value: "Setter Booked" });
  const edges = d.edges as Edge[];
  if (edges.filter((e) => e.to === "k3").map((e) => e.from).sort().join() !== "b6,s5") throw new Error("Call booked's paths no longer meet at k3");
  const card = { type: "pipeline_card", pipeline: "{{crm.pipeline_closer}}", stage: "{{crm.stage_closer_scheduled}}", name: "{{contact.name}} -- {{vars.card_suffix}}", assign_to: "{{appointment.closer.ghl_user_id | default:}}",
    fields: [{ id: "{{crm.field_opportunity_setter_owner}}", value: "{{appointment.set_by | default:}}" }] };
  d.nodes.splice(d.nodes.findIndex((n) => n.id === "k3"), 0,
    { id: "f_card", type: "branch", title: "A new booking or a reschedule?" },
    { ...card, id: "c_new", title: "Closer card → Scheduled, named -- Direct / -- Setter Booked" },
    { ...card, id: "c_rs", title: "Closer card → Scheduled, if it is before the call (its name stays)", keep_name: true, from_stages: ["{{crm.stage_closer_scheduled}}", "{{crm.stage_closer_cancelled}}"] });
  d.edges = edges.filter((e) => e.to !== "k3" && e.from !== "k3" && e.from !== "k5");
  (d.edges as Edge[]).push({ from: "s5", to: "f_card" }, { from: "b6", to: "f_card" },
    { from: "f_card", to: "c_rs", label: "a reschedule", when: RESCHEDULE }, { from: "f_card", to: "c_new", label: "a new booking", else: true },
    { from: "c_new", to: "k3" }, { from: "k3", to: "k4" }, { from: "c_rs", to: "k5" }, { from: "k5", to: "k4" });
  delete node(d, "k3").only_if; delete node(d, "k5").only_if;
  node(d, "k5").title = "The Sales Call for the old time: logged as rescheduled";
  const k5 = d.nodes.splice(d.nodes.findIndex((n) => n.id === "k5"), 1)[0];
  d.nodes.splice(d.nodes.findIndex((n) => n.id === "k3") + 1, 0, k5);
  return d;
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/**
 * D142: a triage call (Tyler: "it should be in the discovery call section"): Call booked's booking paths (the person in GHL, the
 * contact's owner and date, the setter card, the tags), then the call's Discovery Call record, owned by whoever takes the call (the
 * calendar's owner); a reschedule logs the old slot's record rescheduled first. No closer card, no task, no Sales Call: those are
 * the closing call's.
 */
function triageBooked(): Def {
  const d = load("call-booked");
  for (const id of ["s4", "b5"]) drop(d, id);
  const edges = d.edges as Edge[];
  if (edges.filter((e) => e.to === "k3").map((e) => e.from).sort().join() !== "b6,s5") throw new Error("Call booked's paths no longer meet at k3");
  if ((edges.filter((e) => e.from === "k4").map((e) => e.to)).join() !== "v4") throw new Error("Call booked's record no longer leads to the card words");
  const rec = "{{crm.object_discovery_call | default:custom_objects.discovery_call}}";
  const props = { display_label: "{{contact.name | default:Unknown}} — {{appointment.starts_at | date_company:yyyy-MM-dd}}", external_id: "{{appointment.slot_key}}", contact_id: "{{contact.ghl_contact_id | default:}}",
    occurred_at: "{{appointment.starts_at | date_company}}", setter: "{{appointment.closer.name | default:}}", outcome: "scheduled" };
  d.nodes = d.nodes.filter((n) => !["k3", "k4", "k5"].includes(n.id));
  d.nodes.splice(d.nodes.findIndex((n) => n.id === "v4"), 0,
    { id: "d_rs", type: "crm_record", object: rec, key: "{{event.slot.from | default:}}", if_missing: "skip", only_if: RESCHEDULE, properties: { outcome: "rescheduled" }, title: "The Discovery Call for the old time: logged as rescheduled" },
    { id: "d1", type: "crm_record", object: rec, key: "{{appointment.slot_key}}", owner: "{{appointment.closer.ghl_user_id | default:}}", properties: props, title: "The triage call's Discovery Call record",
      relate: [{ association: "{{crm.assoc_discovery_call_contact}}", first: "{{contact.ghl_contact_id | default:}}", second: "{{record.id}}" }] });
  d.edges = edges.filter((e) => !["k3", "k4", "k5"].includes(e.from) && !["k3", "k4", "k5"].includes(e.to));
  (d.edges as Edge[]).push({ from: "s5", to: "d_rs" }, { from: "b6", to: "d_rs" }, { from: "d_rs", to: "d1" }, { from: "d1", to: "v4" });
  return d;
}

/** D142: Call cancelled for a triage call: its trigger held to that call type (any category), the closer card, the rebook task and the Sales Call left out, the Discovery Call record cancelled instead. */
function triageCancelled(callType: string): Def {
  const d = load("call-cancelled");
  const t1 = node(d, "t1"), m = t1.match as { and: unknown[] };
  m.and = m.and.map((x) => (JSON.stringify(x) === JSON.stringify({ eq: ["{{appointment.term.category}}", "closing"] }) ? { eq: ["{{appointment.term.name}}", callType] } : x));
  if (!JSON.stringify(m).includes(callType)) throw new Error("Call cancelled no longer holds itself to closing calls by category");
  for (const id of ["n2", "n4"]) drop(d, id);
  Object.assign(node(d, "n6"), { object: "{{crm.object_discovery_call | default:custom_objects.discovery_call}}", if_missing: "skip", properties: { outcome: "cancelled" }, title: "The Discovery Call record: cancelled" });
  Object.assign(node(d, "n7"), { as: { name: "Triage call cancelled", icon: [":x:", ":calendar:", ":no_entry_sign:"] } });
  return d;
}

/** D143: a triage call's outcome: what the closing call's Call outcome filed does for the Sales Call and the closer card, done for the Discovery Call and the setter card. */
function triageFiled(callType: string): Def {
  const isType = { eq: ["{{appointment.term.name}}", callType] };
  const rec = "{{crm.object_discovery_call | default:custom_objects.discovery_call}}";
  const card = (id: string, stage: string, status: string, title: string) => ({ id, type: "pipeline_card", pipeline: "{{crm.pipeline_setter}}", stage, if_missing: "skip", pick: "latest", status, title });
  return {
    schema: 1, reentry: "always", premise: { check: "contact_exists" },
    nodes: [
      { id: "t1", type: "trigger", event: "appointment.outcome", match: { and: [{ eq: ["{{event._source}}", "disposition"] }, isType] }, title: `A ${callType}'s outcome filed` },
      { id: "t2", type: "trigger", event: "appointment.status_changed", match: { and: [{ eq: ["{{event.status.to}}", "noshow"] }, isType] }, title: `A ${callType} marked a no-show in the CRM` },
      { id: "v_att", type: "set_var", key: "att", value: "{{event.outcome | default:noshow}}", pick: { showed: "showed", noshow: "no_show", rescheduled: "rescheduled" }, else_value: "", title: "Whether they came, in the record's words" },
      { id: "v_res", type: "set_var", key: "res", value: "{{appointment.call_outcome | default:}}", pick: { qualified: "set", follow_up: "follow_up", unqualified: "dq", lost: "not_interested" }, else_value: "", title: "What came of it, in the record's words" },
      { id: "v_line", type: "set_var", key: "line", value: "{{vars.att}}:{{vars.res}}", pick: { "showed:set": "✅ Triage: set", "showed:follow_up": "🔁 Triage: follow up", "showed:dq": "⛔ Triage: DQ", "showed:not_interested": "👋 Triage: not interested", "showed:": "✅ Triage: showed", "no_show:": "👻 Triage: no-show", "rescheduled:": "🔁 Triage: rescheduled on the call" }, else_value: "", title: "The thread line" },
      // D186: the end of day's notes and why a DQ (Tyler: "it should update the discovery calls with what happened and why the person was DQ"); a DQ reason a later answer drops is emptied
      { id: "d1", type: "crm_record", object: rec, key: "{{appointment.slot_key}}", if_missing: "skip", properties: { outcome: "{{vars.att}}", call_result: "{{vars.res}}", dq_reason: "{{event.dq_reason | default:}}", notes: "{{event.notes | default:}}" }, clear: ["dq_reason"], title: "The Discovery Call record: showed or no-show, the result, why a DQ and the notes" },
      { id: "b1", type: "branch", title: "Where the setter card goes" },
      card("c_show", "{{crm.stage_setter_showed}}", "won", "Setter card → Showed, won (set or follow up)"),
      card("c_dq", "{{crm.stage_setter_dq}}", "lost", "Setter card → DQ, marked lost"),
      card("c_ni", "{{crm.stage_setter_not_interested}}", "lost", "Setter card → Not Interested, marked lost"),
      card("c_ns", "{{crm.stage_setter_cancelled}}", "lost", "Setter card → Cancelled / No Show, marked lost"),
      { id: "n1", type: "slack_post", channel: "{{slack.channel.bookings}}", thread_of: "tag:appointment:{{appointment.id}}", thread_only: true, only_if: { neq: ["{{vars.line}}", ""] }, as: { name: "Triage call", icon: ":clipboard:" }, template: "{{vars.line}}", title: "A line in the booking thread" },
      { id: "x1", type: "exit", reason: "filed" },
    ],
    edges: [
      { from: "t1", to: "v_att" }, { from: "t2", to: "v_att" }, { from: "v_att", to: "v_res" }, { from: "v_res", to: "v_line" }, { from: "v_line", to: "d1" }, { from: "d1", to: "b1" },
      { from: "b1", to: "c_ns", label: "no-show", when: { eq: ["{{vars.att}}", "no_show"] } },
      { from: "b1", to: "c_dq", label: "DQ", when: { eq: ["{{vars.res}}", "dq"] } },
      { from: "b1", to: "c_ni", label: "not interested", when: { eq: ["{{vars.res}}", "not_interested"] } },
      { from: "b1", to: "c_show", label: "showed", when: { eq: ["{{vars.att}}", "showed"] } },
      { from: "b1", to: "n1", label: "rescheduled", else: true },
      { from: "c_show", to: "n1" }, { from: "c_dq", to: "n1" }, { from: "c_ni", to: "n1" }, { from: "c_ns", to: "n1" }, { from: "n1", to: "x1" },
    ],
  } as unknown as Def;
}

/**
 * D156 (Tyler: "the setter end of day should change things in HighLevel ... if this person is an outbound dial and they are not
 * booked on the calendar, then yes, they should also be moved by that"): an outbound call's answer, as Triage call filed is a
 * triage call's: the conversation's Discovery Call record (made here, keyed by the conversation, as Setter call logged's was), the
 * setter card, a line under the call's post.
 */
function setterFiled(): Def {
  const rec = "{{crm.object_discovery_call | default:custom_objects.discovery_call}}";
  const card = (id: string, stage: string, status: string | null, title: string) => ({ id, type: "pipeline_card", pipeline: "{{crm.pipeline_setter}}", stage, if_missing: "skip", pick: "latest", ...(status ? { status } : {}), title });
  return {
    schema: 1, reentry: "always", premise: { check: "contact_exists" },
    nodes: [
      { id: "t1", type: "trigger", event: "setter_call.filed", title: "An outbound call answered on the end of day" },
      { id: "v_line", type: "set_var", key: "line", value: "{{event.result}}", pick: { set: "✅ End of day: set", follow_up: "🔁 End of day: follow up", dq: "⛔ End of day: DQ", not_interested: "👋 End of day: not interested" }, else_value: "", title: "The thread line" },
      { id: "d1", type: "crm_record", object: rec, key: "{{event.conversation}}", owner: "{{event.setter_ghl_user_id | default:}}", title: "The call's Discovery Call record",
        properties: { display_label: "{{contact.name | default:Unknown}} — {{event.started_at | date_company:yyyy-MM-dd}}", external_id: "{{event.conversation}}", contact_id: "{{contact.ghl_contact_id | default:}}",
          occurred_at: "{{event.started_at | date_company}}", direction: "{{event.direction | default:}}", duration_sec: "{{event.duration_sec | default:}}", setter: "{{event.setter | default:}}", outcome: "showed",
          recording_url: "{{event.recording_url | default:}}", call_result: "{{event.result}}", dq_reason: "{{event.dq_reason | default:}}", notes: "{{event.note | default:}}" },
        clear: ["dq_reason"],
        relate: [{ association: "{{crm.assoc_discovery_call_contact}}", first: "{{contact.ghl_contact_id | default:}}", second: "{{record.id}}" }] },
      { id: "b1", type: "branch", title: "Where the setter card goes" },
      card("c_set", "{{crm.stage_setter_appointment_set}}", null, "Setter card → Appointment Set"),
      card("c_dq", "{{crm.stage_setter_dq}}", "lost", "Setter card → DQ, marked lost"),
      card("c_ni", "{{crm.stage_setter_not_interested}}", "lost", "Setter card → Not Interested, marked lost"),
      { id: "n1", type: "slack_post", channel: "{{slack.channel.setter_calls}}", thread_of: "tag:setter-call:{{event.conversation}}", thread_only: true, only_if: { neq: ["{{vars.line}}", ""] }, as: { name: "Setter call", icon: ":clipboard:" }, template: "{{vars.line}}", title: "A line under the call's post" },
      { id: "x1", type: "exit", reason: "filed" },
    ],
    edges: [
      { from: "t1", to: "v_line" }, { from: "v_line", to: "d1" }, { from: "d1", to: "b1" },
      { from: "b1", to: "c_set", label: "set", when: { eq: ["{{event.result}}", "set"] } },
      { from: "b1", to: "c_dq", label: "DQ", when: { eq: ["{{event.result}}", "dq"] } },
      { from: "b1", to: "c_ni", label: "not interested", when: { eq: ["{{event.result}}", "not_interested"] } },
      { from: "b1", to: "n1", label: "follow up", else: true },
      { from: "c_set", to: "n1" }, { from: "c_dq", to: "n1" }, { from: "c_ni", to: "n1" }, { from: "n1", to: "x1" },
    ],
  } as unknown as Def;
}

/**
 * D123: the company's own workflows. Each booked-call one is Call booked with both triggers held to its call type (a calendar's
 * own type, D101, so a booking runs exactly one of them), its Sales Call written with its call_type option, and its extra tags
 * on the booking's tag steps. Every closing calendar the install maps must book one of these types: Call booked is taken over,
 * so a closing call of any other type would run nothing.
 */
function ownWorkflows(company: string, setup: DatingSetup, install: InstallBits): Copy[] {
  const out: Copy[] = [];
  const cals = Object.values(install.calendars ?? {}).map((m) => (typeof m === "string" ? { term: m } : m));
  const types = setup.booked.map((b) => b.callType);
  if (new Set(types).size !== types.length) throw new Error("copies.json: each booked workflow needs its own call type");
  for (const t of types) if (!cals.some((m) => m.name === t)) throw new Error(`copies.json: no calendar of the install books "${t}" (calendars[…].name)`);
  for (const m of cals) if (m.term === "closing" && !types.includes(m.name ?? "")) throw new Error(`copies.json: a closing calendar books "${m.name ?? "the default closing type"}", which no booked workflow takes: it would run nothing once Call booked is taken over`);
  const cb = template("call-booked");
  for (const b of setup.booked) {
    const d = b.record === "discovery" ? triageBooked() : bookedWithFork();
    const isType = { eq: ["{{appointment.term.name}}", b.callType] };
    Object.assign(node(d, "t1"), { match: isType, title: `Only a ${b.callType} booking (its calendar's call type)` });
    Object.assign(node(d, "t2"), { match: isType, title: `Only a ${b.callType} moved` });
    if (b.record !== "discovery") { if (!b.salesCallType) throw new Error(`copies.json: ${b.workflow} writes a Sales Call and needs its salesCallType`); (node(d, "k4").properties as Record<string, string>).call_type = b.salesCallType; }
    if (b.card) { const v4 = node(d, "v4"); (v4.value as Record<string, unknown>).name = `${cap(b.card)} rescheduled`; (v4.else_value as Record<string, unknown>).name = `New ${b.card} booked`; }
    if (b.tags?.length) for (const id of ["s5", "b6"]) { const n = node(d, id); n.add = [...(n.add as string[]), ...b.tags]; }
    out.push({ workflow: b.workflow, name: b.name, create: { stage: cb.stage, sort: cb.sort, takesOver: "call-booked" }, definition: d as unknown as Record<string, unknown>,
      note: b.record === "discovery"
        ? `${company}: Call booked for a ${b.callType} booking only (its calendar's call type), a triage call: the setter card and a Discovery Call record, owned by the calendar's owner (D142); no Sales Call, no closer card${b.tags?.length ? `; the tag${b.tags.length > 1 ? "s" : ""} ${b.tags.join(", ")}` : ""}`
        : `${company}: Call booked for a ${b.callType} booking only (its calendar's call type), the Sales Call's call type ${b.salesCallType}${b.tags?.length ? `, and the tag${b.tags.length > 1 ? "s" : ""} ${b.tags.join(", ")}` : ""}; one card fork after the booking paths, a new booking (closer card to Scheduled, the video task) or a reschedule (the card to Scheduled only before the call, its name kept; the old slot's Sales Call logged rescheduled), as PMU's (D105, D107, D123)` });
  }
  if (setup.triageCancelled) {
    const tc = setup.triageCancelled, cc = template("call-cancelled");
    if (!setup.booked.some((b) => b.callType === tc.callType && b.record === "discovery")) throw new Error(`copies.json triageCancelled: no triage booked workflow takes "${tc.callType}"`);
    out.push({ workflow: tc.workflow, name: tc.name, create: { stage: cc.stage, sort: cc.sort + 1 }, definition: triageCancelled(tc.callType) as unknown as Record<string, unknown>,
      note: `${company}: Call cancelled for a ${tc.callType} (a triage call, which Call cancelled leaves to it): the setter card to Cancelled, the Discovery Call record cancelled, the tags, ❌ in the booking thread; no closer card, no task, no Sales Call (D142)` });
  }
  if (setup.triageFiled) {
    const tf = setup.triageFiled, co = template("call-outcome");
    if (!setup.booked.some((b) => b.callType === tf.callType && b.record === "discovery")) throw new Error(`copies.json triageFiled: no triage booked workflow takes "${tf.callType}"`);
    out.push({ workflow: tf.workflow, name: tf.name, create: { stage: co.stage, sort: co.sort + 1 }, definition: triageFiled(tf.callType) as unknown as Record<string, unknown>,
      note: `${company}: a ${tf.callType}'s outcome, filed on the end of day (or a no-show marked in the CRM): the Discovery Call record (showed or no-show, set / follow up / DQ / not interested), the setter card to Showed (won), DQ, Not Interested or Cancelled / No Show (lost), a line in the booking thread (D143)` });
  }
  if (setup.setterFiled) {
    const sf = setup.setterFiled, co = template("call-outcome");
    if (!setup.setterCallReadOnly) throw new Error("copies.json setterFiled: only with setterCallReadOnly (the end of day writes what Setter call logged no longer does)");
    out.push({ workflow: sf.workflow, name: sf.name, create: { stage: co.stage, sort: co.sort + 2 }, definition: setterFiled() as unknown as Record<string, unknown>,
      note: `${company}: a setter's outbound call answered on the end of day (D156): the conversation's Discovery Call record (showed, set / follow up / DQ / not interested), the setter card to Appointment Set or DQ / Not Interested (lost), a line under the call's post in the setter channel` });
  }
  if (setup.fromForm) {
    const tag = install.scopeTag?.trim().toLowerCase();
    if (!tag) throw new Error("copies.json fromForm: the install file has no scopeTag to tag an applicant with");
    const nl = template("new-lead");
    out.push({ workflow: setup.fromForm.workflow, name: setup.fromForm.name, create: { stage: nl.stage, sort: nl.sort - 1 },
      note: `${company}: an application (form.submitted, D122) puts the person in the offer with the tag ${tag} and starts New lead once, if they are not a lead yet (D123)`,
      definition: { schema: 1, reentry: "always", premise: { check: "contact_exists" },
        nodes: [
          { id: "t1", type: "trigger", event: "form.submitted" },
          { id: "n1", type: "tags", title: `Into the offer: the tag ${tag}`, add: [tag] },
          { id: "n2", type: "record", title: "Start New lead, once a person", event: "lead.created", start: true, only_if: { eq: ["{{contact.is_lead}}", false] },
            data: { ghl_contact_id: "{{contact.ghl_contact_id | default:}}", form_id: "{{event.form_id}}", response_id: "{{event.response_id}}", by: "form" } },
          { id: "x1", type: "exit", reason: "done" },
        ],
        edges: [{ from: "t1", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "x1" }] } });
  }
  return out;
}

const OBJECTION_LINE = /"primary_objection": "price"(?: \| "[a-z_]+")* \| ""/;
/**
 * The company's own call prompts, from the shipped defaults: the Sales Call's objection options are its own (salesCall.objections),
 * and a setter's triage does not ask about a medical reason. Bound at install as prompt.<name> (the company's text wins).
 */
export function datingPrompts(objections: string[]): Record<string, string> {
  const line = `"primary_objection": ${[...objections, ""].map((o) => JSON.stringify(o)).join(" | ")}`;
  const own = (name: string) => { const p = defaultPrompts[name]; if (!OBJECTION_LINE.test(p)) throw new Error(`prompt ${name} has no objection line`); return p.replace(OBJECTION_LINE, line); };
  const triage = defaultPrompts.setter_call_notes;
  if (!triage.includes("decision maker, medical)")) throw new Error("setter_call_notes has no medical triage line");
  return { call_notes: own("call_notes"), call_review: own("call_review"), setter_call_notes: triage.replace("decision maker, medical)", "decision maker)") };
}
