/**
 * D147: playbooks. A playbook is a sales process: the shipped templates every offer runs, and the copies of them its process
 * changes, built from the offer's own params. A company runs one playbook (installs/<company>/playbook.json names it and holds
 * its params); its copies are rebuilt from the current templates on every build, so a template's fix reaches it, and a copy
 * nobody rebuilt shows as stale rather than silently falling behind. The wizard (#53) picks a playbook from how an offer sells.
 */
import { z } from "zod";
import { oneBoardCopies, type OneBoardParams } from "./one-board";
import { datingCopies, datingPrompts, type DatingSetup, type DatingWords } from "./application-triage";
import type { Copy } from "./kit";
import { OBJECTIONS } from "./ghl-setup";

export type { Copy } from "./kit";
/** How an offer sells, as the wizard asks it; what tells one playbook from another. */
export type Traits = {
  /** one board carries the whole journey, or a setter board and a closer board */
  boards: "one" | "setter_and_closer";
  /** how calls get booked: the lead books themself, a setter books them, or both */
  booking: ("self" | "setter")[];
  /** an application form before the call */
  application: boolean;
  /** a short qualifying (triage) call before the closing call */
  triage: boolean;
};
/** What a playbook reads from the company's install file (never secrets). */
export type InstallBits = { scopeTag?: string; calendars?: Record<string, string | { term: string; name?: string }>; salesCall?: { objections?: string[] }; prompts?: Record<string, string> };
export type Built = { copies: Copy[]; /** what the build writes into the install file, over what is there */ install?: Record<string, unknown> };
export type Playbook = {
  slug: string; name: string; about: string; traits: Traits;
  /** The shipped templates its copies change or take over (D123); the rest run as shipped. */
  changes: string[];
  /** Pure: the company's copies from its params and install file. Throws, naming the param, when the params are not right. */
  build(company: string, params: unknown, install: InstallBits): Built;
  /** D152: the params a new offer starts from (the offer's name in them); the wizard keeps them on the client, Tyler edits them. */
  defaults(offer: string): unknown;
  /** D155: published params (a template business's) made a given offer's: whatever in them names the offer. */
  forOffer(params: unknown, offer: string): unknown;
};

const words = z.object({ welcome: z.object({ subject: z.string(), email: z.string(), sms: z.string() }), setterDq: z.object({ result: z.string(), reasons: z.record(z.string()) }) });
// D142 (main): a booked call records a Sales Call (`sales`, the default, which needs its salesCallType) or, for a triage call, a Discovery Call
const booked = z.object({ workflow: z.string().min(1), name: z.string().min(1), callType: z.string().min(1), salesCallType: z.string().min(1).optional(), record: z.enum(["sales", "discovery"]).optional(), card: z.string().min(1).optional(), tags: z.array(z.string()).optional() })
  .refine((b) => b.record === "discovery" || !!b.salesCallType, { message: "a booked call that writes a Sales Call needs its salesCallType", path: ["salesCallType"] });
const setup = z.object({ booked: z.array(booked), fromForm: z.object({ workflow: z.string().min(1), name: z.string().min(1) }).optional() });
const label = z.string().trim().min(1);
const oneBoard = z.object({
  name: label, board: label,
  stages: z.object({ newLead: label, booked: label, rescheduled: label, cancelled: label, noShow: label, confirmed: label, unresponsive: label, purchase: label, won: label }),
  lead: z.object({ tags: z.array(label), label }), cardNames: z.object({ self: label, setter: label }), appointmentDateFormat: label,
  callTypes: z.object({ pick: z.record(label), otherwise: label, title: label }),
  objections: z.array(label).min(1), recordedDispositions: z.array(label).min(1), paymentObject: label, slackIcons: z.array(label).min(1),
});
const parse = <T>(schema: z.ZodType<T>, params: unknown, slug: string): T => {
  const r = schema.safeParse(params);
  if (!r.success) throw new Error(`${slug} params: ${r.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}`);
  return r.data;
};

export const playbooks: Playbook[] = [
  {
    slug: "setter-closer", name: "Setter and closer",
    about: "Hair's process: a setter board and a closer board, calls booked by the lead or a setter, the shipped templates as they are.",
    traits: { boards: "setter_and_closer", booking: ["self", "setter"], application: false, triage: false },
    changes: [],
    build: () => ({ copies: [] }),
    defaults: () => undefined,
    forOffer: (p) => p,
  },
  {
    slug: "one-board", name: "One board",
    about: "PMU's process: one closer board carries a person from New Lead to won, no setter board; who set a call comes from the booking.",
    traits: { boards: "one", booking: ["self", "setter"], application: false, triage: false },
    changes: ["new-lead", "call-booked", "call-cancelled", "call-outcome", "call-recorded", "deal-closed", "payment-recorded", "pre-call-sequence", "card-moved"],
    build: (_company, params) => ({ copies: oneBoardCopies(parse(oneBoard, params, "one-board") as OneBoardParams) }),
    forOffer: (p, offer) => ({ ...(p as OneBoardParams), name: offer, board: offer }),
    defaults: (offer): OneBoardParams => ({
      name: offer, board: offer,
      stages: { newLead: "New Lead", booked: "Booked Call", rescheduled: "Rescheduled", cancelled: "Cancelled", noShow: "No Show", confirmed: "Call Confirmed", unresponsive: "Unresponsive", purchase: "Purchase", won: "Closed Won" },
      lead: { tags: [], label: "a lead tag" }, cardNames: { self: "Direct", setter: "Setter" }, appointmentDateFormat: "MM-dd-yyyy HH:mm",
      callTypes: { pick: {}, otherwise: "closing", title: "Call type" }, objections: OBJECTIONS, recordedDispositions: ["closed_won", "follow_up", "lost", "dq"],
      paymentObject: "custom_objects.payment", slackIcons: [":telephone_receiver:"],
    }),
  },
  {
    slug: "application-triage", name: "Application and triage",
    about: "Dating's process: an application form, a setter's triage call before the closing call, a setter board and a closer board, and a booked-call workflow per call type.",
    traits: { boards: "setter_and_closer", booking: ["self", "setter"], application: true, triage: true },
    changes: ["deal-closed", "setter-call-logged", "call-booked"],
    build: (company, params, install) => {
      const p = parse(z.object({ words, setup: setup.optional() }), params, "application-triage");
      if (!install.salesCall?.objections?.length) throw new Error("application-triage: the install file's salesCall.objections is needed for the call prompts");
      return { copies: datingCopies(company, p.words as DatingWords, p.setup ? { setup: p.setup as DatingSetup, install } : undefined),
        install: { prompts: { ...(install.prompts ?? {}), ...datingPrompts(install.salesCall.objections) } } };
    },
    forOffer: (p) => p,
    // the words start as placeholders, which send nothing (D118) until Tyler writes them in the Messages step
    defaults: (offer) => ({ words: {
      welcome: { subject: `[placeholder — ${offer}'s welcome email subject]`, email: `<p>Hi {{contact.first_name | default:there}},</p><p>[placeholder — ${offer}'s welcome email]</p>`, sms: `[placeholder — ${offer}'s welcome text]` },
      setterDq: { result: `[placeholder — ${offer}'s DQ wording] The lead does not qualify: the setter or the lead established they are not a fit for the offer, or it is a bad or wrong contact.`,
        reasons: Object.fromEntries(["budget", "age", "geo", "medical", "timeline", "no_problem", "competitor", "bad_contact"].map((r) => [r, `[placeholder] ${r.replace("_", " ")}`]).concat([["other", "Any other reason, or the transcript does not say."]])) },
    } }),
  },
];
export const playbookOf = (slug: string): Playbook => { const p = playbooks.find((x) => x.slug === slug); if (!p) throw new Error(`no playbook "${slug}" (there are ${playbooks.map((x) => x.slug).join(", ")})`); return p; };

/** A company's playbook file (installs/<company>/playbook.json): which playbook, its params, and params kept in their own files ({ param: file }). */
export type PlaybookFile = { playbook: string; params?: Record<string, unknown>; files?: Record<string, string> };
