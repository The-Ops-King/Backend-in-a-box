/**
 * #53 P1 (D148): the wizard's first step, the offer as Tyler describes it. One list of fields drives the form and the check, and
 * the answers pick the playbook (D147) and say, workflow by workflow, what fits as shipped, what needs a tweak, what has to be
 * built and what stays off. The gaps are that client's build list. No playbook fits exactly? The closest is picked and the
 * differences are in the report (Tyler, 2026-10-18).
 */
import { playbooks, type Playbook, type Traits } from "@/playbooks";
import { templates } from "@/templates";

export type IntakeField = {
  key: string; label: string; section: "Offer" | "Sales journey" | "Software" | "Team";
  type: "text" | "money" | "yesno" | "select" | "multi" | "textarea";
  options?: { value: string; label: string }[]; required?: boolean; help?: string;
};
export type Intake = Record<string, string | string[] | boolean>;

const o = (value: string, label: string) => ({ value, label });
export const INTAKE_FIELDS: IntakeField[] = [
  { key: "business", label: "Business (the client)", section: "Offer", type: "text", required: true },
  { key: "price", label: "Program price ($)", section: "Offer", type: "money", required: true, help: "a new deal's value until the closer sets one" },
  { key: "deposits", label: "Takes deposits", section: "Offer", type: "yesno", required: true },
  { key: "payment_plans", label: "Sells payment plans", section: "Offer", type: "yesno", required: true },
  { key: "lead_paths", label: "How leads come in", section: "Sales journey", type: "multi", required: true,
    options: [o("ads_vsl_application", "Ads → VSL → application → book"), o("ads_direct_book", "Ads → book directly"), o("organic_dm", "DMs (Instagram and the like)"), o("referrals", "Referrals"), o("other", "Other")] },
  { key: "application", label: "Application form", section: "Sales journey", type: "select", required: true,
    options: [o("none", "None"), o("typeform", "Typeform"), o("ghl_form", "GHL form"), o("other", "Other")] },
  { key: "setters", label: "Setters book or qualify calls", section: "Sales journey", type: "yesno", required: true },
  { key: "triage", label: "A short triage call before the closing call", section: "Sales journey", type: "yesno", required: true },
  { key: "boards", label: "Pipeline", section: "Sales journey", type: "select", required: true,
    options: [o("one", "One board carries the whole journey"), o("setter_and_closer", "A setter board and a closer board"), o("unsure", "Not decided")] },
  { key: "journey", label: "The sales journey, in your words", section: "Sales journey", type: "textarea", required: true,
    help: "from first touch to paid and onboarded: what happens, who does it, what the lead gets" },
  { key: "crm", label: "CRM", section: "Software", type: "select", required: true, options: [o("ghl", "GoHighLevel"), o("hubspot", "HubSpot"), o("close", "Close"), o("other", "Other")] },
  { key: "booking", label: "Booking", section: "Software", type: "select", required: true, options: [o("calendly", "Calendly"), o("ghl", "GHL calendars"), o("iclosed", "iClosed"), o("other", "Other")] },
  { key: "payments", label: "Payments", section: "Software", type: "select", required: true, options: [o("whop", "Whop"), o("stripe", "Stripe"), o("other", "Other"), o("none", "Not taken through a processor")] },
  { key: "recording", label: "Call recording", section: "Software", type: "select", required: true, options: [o("fathom", "Fathom"), o("other", "Other"), o("none", "None")] },
  { key: "agreement", label: "Agreement signing", section: "Software", type: "select", required: true, options: [o("ghl_documents", "GHL documents"), o("other", "Other"), o("none", "None")] },
  { key: "closers", label: "Closers' emails", section: "Team", type: "textarea", help: "one per line, as they are in the CRM" },
  { key: "setter_emails", label: "Setters' emails", section: "Team", type: "textarea", help: "one per line" },
];

/** What is wrong with the answers, one line each; none means they are complete. */
export function intakeProblems(intake: unknown): string[] {
  if (!intake || typeof intake !== "object" || Array.isArray(intake)) return ["the answers are missing"];
  const a = intake as Record<string, unknown>, out: string[] = [];
  for (const k of Object.keys(a)) if (!INTAKE_FIELDS.some((f) => f.key === k)) out.push(`${k}: not a question the wizard asks`);
  for (const f of INTAKE_FIELDS) {
    const v = a[f.key];
    const blank = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (blank) { if (f.required) out.push(`${f.label}: required`); continue; }
    if (f.type === "yesno" && typeof v !== "boolean") out.push(`${f.label}: yes or no`);
    else if (f.type === "money" && !(typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim()))) out.push(`${f.label}: an amount in dollars, like 5000`);
    else if (f.type === "select" && !f.options!.some((x) => x.value === v)) out.push(`${f.label}: one of ${f.options!.map((x) => x.label).join(", ")}`);
    else if (f.type === "multi" && !(Array.isArray(v) && v.every((x) => f.options!.some((y) => y.value === x)))) out.push(`${f.label}: from the list`);
    else if (["text", "textarea"].includes(f.type) && typeof v !== "string") out.push(`${f.label}: text`);
  }
  if (a.setters === false && a.triage === true) out.push("A triage call is a setter's call: with no setters, there is no triage call");
  return out;
}
/** Emails from a one-per-line answer. */
export const emailsOf = (v: unknown): string[] => (typeof v === "string" ? v.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes("@")) : []);

export type Fit = "fits" | "tweak" | "build" | "off";
export type WorkflowFit = { slug: string; name: string; fit: Fit; why: string };
export type FitReport = {
  playbook: string; playbookName: string; why: string;
  others: { slug: string; name: string; differs: string[] }[];
  workflows: WorkflowFit[];
  /** what this client needs that the engine does not do yet: their build list */
  gaps: string[];
  /** said once, above the list */
  notes: string[];
};

/** How the answers sell, in the playbooks' terms. */
export function traitsOf(a: Intake): Partial<Traits> {
  return {
    ...(a.boards === "one" || a.boards === "setter_and_closer" ? { boards: a.boards } : {}),
    booking: a.setters ? ["self", "setter"] : ["self"],
    application: a.application !== undefined && a.application !== "none",
    triage: a.triage === true,
  };
}
/** Where a playbook's process differs from the answers, in words. */
function differences(p: Playbook, t: Partial<Traits>): string[] {
  const out: string[] = [];
  if (t.boards && t.boards !== p.traits.boards) out.push(t.boards === "one" ? "it uses a setter board and a closer board; this offer has one board" : "it has one board; this offer has a setter board and a closer board");
  if (t.application !== undefined && t.application !== p.traits.application) out.push(t.application ? "it has no application form; this offer has one" : "it starts from an application form; this offer has none");
  if (t.triage !== undefined && t.triage !== p.traits.triage) out.push(t.triage ? "it has no triage call; this offer has one" : "it has a triage call; this offer has none");
  if (t.booking && t.booking.includes("setter") && !p.traits.booking.includes("setter")) out.push("it has no setters; this offer has them");
  return out;
}

/** `chosen`: the playbook Tyler picked over the closest one; the report is then about that one. */
export function fitReport(a: Intake, kind: "new" | "takeover" = "new", chosen?: string): FitReport {
  const t = traitsOf(a);
  // the closest playbook: the fewest differences, a board mismatch counting double (it changes every card move); ties go to the earlier one
  const scored = playbooks.map((p) => ({ p, differs: differences(p, t), cost: differences(p, t).length + (t.boards && t.boards !== p.traits.boards ? 1 : 0) }));
  const best = scored.find((x) => x.p.slug === chosen) ?? [...scored].sort((x, y) => x.cost - y.cost)[0];
  const pb = best.p;
  const notes: string[] = [];
  if (kind === "takeover") notes.push("A takeover: every step of their current system is mapped to a workflow before anything swaps over (#53 P2); the report below is for the engine's side.");
  if (a.crm && a.crm !== "ghl") notes.push(`The engine reads and writes GoHighLevel. ${label("crm", a.crm)} needs its own CRM connector before any workflow can run (#53).`);
  if (best.differs.length) notes.push(chosen === pb.slug
    ? `${pb.name}, as chosen, differs from this offer (${best.differs.join("; ")}). Those differences are on the build list.`
    : `No playbook matches exactly: ${pb.name} is the closest (${best.differs.join("; ")}). Those differences are on the build list.`);
  const gaps = new Set<string>(best.differs.map((d) => `Playbook: ${d}`));

  const workflows = templates.map((tp): WorkflowFit => {
    const s = tp.slug, w = (fit: Fit, why: string): WorkflowFit => ({ slug: s, name: tp.name, fit, why });
    if (a.crm && a.crm !== "ghl") return w("build", `needs a ${label("crm", a.crm)} connector`);
    const booking = ["call-booked", "call-cancelled", "pre-call-sequence", "no-show-recovery", "cancellation-rebook", "calendar-availability", "call-outcome"];
    if (booking.includes(s) && a.booking && !["calendly", "ghl"].includes(a.booking as string)) { gaps.add(`Bookings from ${label("booking", a.booking)}: the engine reads Calendly and GHL calendars`); return w("build", `bookings come from ${label("booking", a.booking)}, which the engine does not read yet`); }
    if (["payment-recorded", "payment-failed", "payment-unlinked"].includes(s)) {
      if (a.payments === "none") return w("off", "no payment processor to hear from");
      if (a.payments && a.payments !== "whop") return w("tweak", `payments from ${label("payments", a.payments)} come in through a Zap into the payment door (the engine reads Whop itself)`);
      if (s === "payment-recorded" && a.payment_plans === true) { gaps.add("Payment plans: what is due when is not tracked yet (problem 27)"); return w("tweak", "payment plans: what is due when is not tracked yet"); }
    }
    if (["call-recorded", "recording-unlinked"].includes(s)) {
      if (a.recording === "none") return w("off", "calls are not recorded");
      if (a.recording && a.recording !== "fathom") return w("tweak", `recordings from ${label("recording", a.recording)} come in through a Zap into the recording door`);
    }
    if (["agreement-send-manually", "agreement-signed", "agreement-chase"].includes(s)) {
      if (a.agreement === "none") return w("off", "no agreement is signed");
      if (a.agreement && a.agreement !== "ghl_documents") { gaps.add(`Agreements in ${label("agreement", a.agreement)}: the engine sends and watches GHL documents`); return w("build", `agreements are signed in ${label("agreement", a.agreement)}, which the engine does not watch`); }
    }
    if (s === "deal-closed" && a.agreement === "none") return w("tweak", "it closes a deal when it is paid and signed; with no agreement it must close on payment alone");
    if (s === "setter-call-logged" && a.setters === false) return w("off", "no setters");
    // D152: Setter call logged moves the setter board's card; on one board there is none, and the playbook has no copy of it yet
    if (s === "setter-call-logged" && pb.traits.boards === "one") { gaps.add("Setter call logged on one board: it moves a setter card, and one board has none (a one-board copy is to build)"); return w("build", "it moves the setter board's card, and one board has none: a one-board copy is to build"); }
    if (s === "new-lead" && Array.isArray(a.lead_paths) && a.lead_paths.includes("organic_dm")) { gaps.add("DM leads: nothing brings an Instagram DM lead into the CRM yet (problem 7)"); return w("tweak", "DM leads reach it only once they are in the CRM"); }
    if (s === "new-lead" && a.application === "other") return w("tweak", "the application's answers come in through a Zap");
    if (pb.changes.includes(s)) return w("fits", `the ${pb.name} playbook's own copy`);
    return w("fits", "as shipped");
  });
  return {
    playbook: pb.slug, playbookName: pb.name,
    why: best.differs.length ? `closest: ${pb.about}` : `matches: ${pb.about}`,
    others: scored.filter((x) => x.p !== pb).map((x) => ({ slug: x.p.slug, name: x.p.name, differs: x.differs })),
    workflows, gaps: [...gaps], notes,
  };
}

const label = (key: string, value: unknown) => INTAKE_FIELDS.find((f) => f.key === key)?.options?.find((x) => x.value === value)?.label ?? String(value);
