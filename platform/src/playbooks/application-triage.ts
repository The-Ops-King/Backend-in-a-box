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
 * D147: this is the application-and-triage playbook (two boards, an application form, a triage call, a booked-call workflow per
 * call type); it was installs/dating/copies.ts.
 */
import { after, drop, load, node, RESCHEDULE, template, type Copy, type Def, type Edge } from "./kit";
import { defaultPrompts } from "@/prompts";
import { isPlaceholderCopy } from "@/engine/readiness";

export type DatingWords = {
  welcome: { subject: string; email: string; sms: string };
  /** a3's meaning of a DQ, and a4's words for each setter DQ reason (the setter_dq_reason options) */
  setterDq: { result: string; reasons: Record<string, string> };
};
/**
 * D123: `booked`, one per call type a calendar of the install books (its `calendars[…].name`): the workflow's file and name, the
 * Sales Call's `call_type` option it writes, and any tags a booking of that type adds. `fromForm`: the applicant workflow.
 */
export type DatingSetup = {
  booked: { workflow: string; name: string; callType: string; salesCallType: string; tags?: string[] }[];
  fromForm?: { workflow: string; name: string };
};
type InstallBits = { scopeTag?: string; calendars?: Record<string, string | { term: string; name?: string }> };

const DQ_REASONS = ["budget", "age", "geo", "medical", "timeline", "no_problem", "competitor", "bad_contact", "other"];
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

  // Setter call logged: why a setter DQs a lead, in the company's words
  const scl = load("setter-call-logged");
  const reasons = Object.keys(words.setterDq.reasons);
  if (reasons.length !== DQ_REASONS.length || DQ_REASONS.some((r) => !words.setterDq.reasons[r]?.trim())) throw new Error(`setterDq.reasons needs words for each of ${DQ_REASONS.join(", ")}`);
  const a3 = node(scl, "a3"), a4 = node(scl, "a4");
  (a3.criteria as Record<string, string>).dq = words.setterDq.result;
  a4.criteria = Object.fromEntries(DQ_REASONS.map((r) => [r, words.setterDq.reasons[r]]));
  const dqHeld = [words.setterDq.result, ...Object.values(words.setterDq.reasons)].some(isPlaceholderCopy);
  if (dqHeld) a4.title = "Jev: why disqualified? [placeholder: the company's DQ reasons are not written yet]";
  out.push({ workflow: "setter-call-logged", definition: scl as unknown as Record<string, unknown>,
    note: `${company}: why a setter DQs a lead, in the company's words (installs/${company}/words.json)${dqHeld ? "; still placeholders" : ""}, not Hair's (D118)` });
  if (own) out.push(...ownWorkflows(company, own.setup, own.install));
  return out;
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
    const d = bookedWithFork();
    const isType = { eq: ["{{appointment.term.name}}", b.callType] };
    Object.assign(node(d, "t1"), { match: isType, title: `Only a ${b.callType} booking (its calendar's call type)` });
    Object.assign(node(d, "t2"), { match: isType, title: `Only a ${b.callType} moved` });
    (node(d, "k4").properties as Record<string, string>).call_type = b.salesCallType;
    if (b.tags?.length) for (const id of ["s5", "b6"]) { const n = node(d, id); n.add = [...(n.add as string[]), ...b.tags]; }
    out.push({ workflow: b.workflow, name: b.name, create: { stage: cb.stage, sort: cb.sort, takesOver: "call-booked" }, definition: d as unknown as Record<string, unknown>,
      note: `${company}: Call booked for a ${b.callType} booking only (its calendar's call type), the Sales Call's call type ${b.salesCallType}${b.tags?.length ? `, and the tag${b.tags.length > 1 ? "s" : ""} ${b.tags.join(", ")}` : ""}; one card fork after the booking paths, a new booking (closer card to Scheduled, the video task) or a reschedule (the card to Scheduled only before the call, its name kept; the old slot's Sales Call logged rescheduled), as PMU's (D105, D107, D123)` });
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
