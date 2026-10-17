import type { PoolClient } from "pg";
import { one } from "@/db/client";

/**
 * D131: what the harness's staged calls say. The closer call (`record`) is read by the call review and the setter call (`call`) by
 * the setter classifier, so a script in another business's words makes the AI file the wrong thing (Dating's staged call came back
 * "closed won" about hair loss). A company's own scripts are bound from its install; without them, an offer-neutral pair.
 * `{first}` is the contact's first name; the speakers are roles, named at staging.
 */
export type ScriptLine = { speaker: "closer" | "setter" | "prospect"; text: string };
export type HarnessTranscripts = { closerCall?: ScriptLine[]; setterCall?: ScriptLine[] };
export const HARNESS_KEY = "harness.transcripts";

export const DEFAULT_SCRIPTS: Required<HarnessTranscripts> = {
  closerCall: [
    { speaker: "closer", text: "Thanks for hopping on. Tell me what made you reach out." },
    { speaker: "prospect", text: "I have been trying to fix this on my own for about two years and it is not working." },
    { speaker: "closer", text: "Got it. Here is how the program works and what it costs." },
    { speaker: "prospect", text: "That is a lot right now, but I want to do this. Can I split it?" },
    { speaker: "closer", text: "Yes, two payments. Let us get you started." },
  ],
  setterCall: [
    { speaker: "setter", text: "Hey {first}, this is the team calling about the form you filled out. Got two minutes?" },
    { speaker: "prospect", text: "Yeah, sure." },
    { speaker: "setter", text: "What made you reach out?" },
    { speaker: "prospect", text: "I have been stuck on this for about a year and I want to deal with it." },
    { speaker: "setter", text: "Makes sense. If we could fix that, what would that change for you?" },
    { speaker: "prospect", text: "A lot, honestly. What does it cost?" },
    { speaker: "setter", text: "The specialist walks you through pricing on the call. Does Thursday at two work?" },
    { speaker: "prospect", text: "Thursday at two works." },
  ],
};

const SPEAKERS: Record<keyof HarnessTranscripts, string[]> = { closerCall: ["closer", "prospect"], setterCall: ["setter", "prospect"] };
/** Why these scripts cannot be staged, or null. */
export function harnessProblem(h: unknown): string | null {
  if (!h || typeof h !== "object" || Array.isArray(h)) return "{ closerCall?, setterCall? }, each a list of { speaker, text }";
  for (const [k, lines] of Object.entries(h)) {
    const who = SPEAKERS[k as keyof HarnessTranscripts];
    if (!who) return `"${k}" is not closerCall or setterCall`;
    if (!Array.isArray(lines) || lines.length < 2) return `${k}: at least two lines`;
    for (const [i, l] of lines.entries()) {
      if (!l || typeof l !== "object" || !who.includes((l as ScriptLine).speaker)) return `${k}[${i}]: speaker is ${who.join(" or ")}`;
      if (typeof (l as ScriptLine).text !== "string" || !(l as ScriptLine).text.trim()) return `${k}[${i}]: text is needed`;
    }
    if (!who.every((s) => lines.some((l: ScriptLine) => l.speaker === s))) return `${k}: both ${who.join(" and ")} speak`;
  }
  return null;
}

/** The company's scripts over the defaults. */
export async function harnessScripts(c: PoolClient, companyId: string): Promise<Required<HarnessTranscripts>> {
  const raw = (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, HARNESS_KEY]))?.value.toString("utf8");
  let own: HarnessTranscripts = {};
  try { const v = raw ? JSON.parse(raw) : {}; if (!harnessProblem(v)) own = v; } catch { /* a binding that does not parse is no script */ }
  return { closerCall: own.closerCall ?? DEFAULT_SCRIPTS.closerCall, setterCall: own.setterCall ?? DEFAULT_SCRIPTS.setterCall };
}
