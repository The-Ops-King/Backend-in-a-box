import { z } from "zod";
import { exprsOf, parseTemplate } from "@/workflow/template";

/**
 * The facts the platform works out that rest on a business rule, and the typed settings each rule reads. Data only,
 * so the workflow validator can say which settings a workflow that reads one of these needs before it is enabled.
 */

/** The typed settings the worked-out facts read: their key, type and meaning. None has a value in code. */
export const FACT_SETTINGS = {
  "payments.deposit_products": { type: z.array(z.string().min(1)), what: "The payment provider's product or plan ids that are deposits. An empty list means the offer declares none (then deposit_by_name decides).", v1: "payments.deposit_products (D119), else none" },
  "payments.deposit_by_name": { type: z.boolean(), what: "With no deposit products declared: whether a payment whose product or plan name has the word \"deposit\" is a deposit.", v1: "always yes (D119 addendum), written in code" },
  "payments.contract_value": { type: z.number().positive(), what: "The program's price, for a deal with no value of its own: what paid in full and cleared are measured against.", v1: "companies.contract_value_default" },
  "payments.cleared_tolerance": { type: z.number().min(0), what: "How far under the price a total may be and still count as paid in full (rounding).", v1: "0.01, written in code" },
  "people.closer_from": { type: z.array(z.enum(["closer_card", "contact_owner", "latest_call"])).min(1), what: "Where the contact's closer comes from, first that has one: the open (else won) card on crm.pipeline_closer's owner, the contact's CRM owner, the closer of their latest call.", v1: "closer card's owner, else contact owner, written in code" },
  "people.setter_from": { type: z.array(z.string().regex(/^(field:[a-z][a-z0-9_]*|booking)$/)).min(1), what: "Where the contact's setter comes from, first that has one: a contact field holding the setter's name (field:<name>), or who set their latest booking (booking).", v1: "the contact field bound as crm.field_contact_setter, written in code" },
  "setter_result.set_within_min": { type: z.number().int().min(0), what: "Minutes after a setter call's hang-up within which a booking through a setter link makes the call Set (the Set window).", v1: "setter_result.set_within_min, default 30 in code" },
} as const;
export type FactSetting = keyof typeof FACT_SETTINGS;

const DEPOSIT_RULE: FactSetting[] = ["payments.deposit_products", "payments.deposit_by_name"];

/**
 * The worked-out facts that rest on a rule, by the path a workflow reads, with the settings each needs. A path under
 * one (`contact.closer.mention`) needs the same. Facts not listed (cash collected, signed, the next call, latest
 * appointment, records, cards) are what the facts say, with no rule to set.
 */
export const DERIVED_FACTS: Record<string, { requires: FactSetting[]; optional?: string[]; what: string }> = {
  "payment.kind": { requires: [...DEPOSIT_RULE, "payments.contract_value", "payments.cleared_tolerance"], what: "deposit, installment, balance, paid_in_full, refund or failed" },
  "payment.cleared": { requires: ["payments.contract_value", "payments.cleared_tolerance"], what: "the running total has reached the price" },
  "payment.contract_value": { requires: ["payments.contract_value"], what: "the deal's value, else the program's price" },
  "payment.outstanding": { requires: ["payments.contract_value"], what: "what is left to pay" },
  "payment.prior_non_deposit_total": { requires: DEPOSIT_RULE, what: "what was paid before this payment, deposits (and their refunds) left out" },
  "contact.paid_non_deposit": { requires: DEPOSIT_RULE, what: "anything beyond a deposit has been paid" },
  "contact.deposit_paid": { requires: DEPOSIT_RULE, what: "a deposit has been paid" },
  "contact.revenue": { requires: ["payments.contract_value"], what: "what the deal is worth" },
  "contact.closer": { requires: ["people.closer_from"], what: "the contact's closer" },
  "contact.setter": { requires: ["people.setter_from"], what: "the contact's setter" },
  "contact.owner": { requires: [], optional: ["crm.default_closer"], what: "the contact's CRM owner, else the offer's default closer when it names one" },
  "recording.set_until": { requires: ["setter_result.set_within_min"], what: "when the Set window closes" },
};

/** The rule a path reads, if any (the longest listed path it is, or is under). */
export function derivedFactOf(path: string): { fact: string; requires: FactSetting[]; optional: string[] } | undefined {
  const fact = Object.keys(DERIVED_FACTS).filter((f) => path === f || path.startsWith(`${f}.`)).sort((a, b) => b.length - a.length)[0];
  return fact ? { fact, requires: DERIVED_FACTS[fact]!.requires, optional: DERIVED_FACTS[fact]!.optional ?? [] } : undefined;
}


/** The settings a template's reads of worked-out facts need (`required`), and those they read only if set (`optional`). */
export function factSettingsIn(t: string): { facts: string[]; required: string[]; optional: string[] } {
  const facts = new Set<string>(), required = new Set<string>(), optional = new Set<string>();
  for (const e of exprsOf(parseTemplate(t))) {
    const f = derivedFactOf(e.path);
    if (!f) continue;
    facts.add(f.fact); f.requires.forEach((k) => required.add(k)); f.optional.forEach((k) => optional.add(k));
  }
  return { facts: [...facts], required: [...required], optional: [...optional].filter((k) => !required.has(k)) };
}
