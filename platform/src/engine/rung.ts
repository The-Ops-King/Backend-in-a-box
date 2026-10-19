import type { Definition, Node } from "./definition";
import type { Mode } from "./mode";

/**
 * #48 (D170): the rung a workflow is meant to stand on while its company is still being proven, from what it does. A workflow
 * with a step that reaches a contact (a text, an email, a document to sign, an outbound webhook: everything quiet holds) waits
 * in test until its words are approved and it is proven on test contacts; one that only does the team's work (the CRM, Slack,
 * reports, end of day) can stand in quiet from the start, real for everyone, nothing reaching a contact. This is the plan the
 * go-live board starts from; nothing moves a workflow by it alone (a rung still passes the readiness gate, D92).
 */
export const CONTACT_STEP_TYPES = ["send_sms", "send_email", "send_document", "webhook"] as const;
export type StartRung = Extract<Mode, "test" | "quiet">;

/** The steps that reach a contact, whatever their conditions (a held send still sends once its condition is met). */
export const contactSteps = (def: Definition): Node[] => def.nodes.filter((n) => (CONTACT_STEP_TYPES as readonly string[]).includes(n.type));

export function startRung(def: Definition): { rung: StartRung; why: string } {
  const steps = contactSteps(def);
  if (!steps.length) return { rung: "quiet", why: "nothing in it reaches a contact" };
  const what = [...new Set(steps.map((n) => STEP_WORDS[n.type as (typeof CONTACT_STEP_TYPES)[number]]))];
  return { rung: "test", why: `it ${what.join(", ")}` };
}

const STEP_WORDS: Record<(typeof CONTACT_STEP_TYPES)[number], string> = {
  send_sms: "texts the contact", send_email: "emails the contact", send_document: "sends a document to sign", webhook: "calls an outside webhook",
};
