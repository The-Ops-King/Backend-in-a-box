import { z } from "zod";

// ---- predicate tree ---------------------------------------------------------
export type Predicate =
  | { eq: [unknown, unknown] } | { neq: [unknown, unknown] }
  | { gt: [unknown, unknown] } | { gte: [unknown, unknown] } | { lt: [unknown, unknown] } | { lte: [unknown, unknown] }
  | { in: [unknown, unknown[]] } | { has: [unknown, unknown] } | { exists: string }
  | { and: Predicate[] } | { or: Predicate[] } | { not: Predicate };
export const Predicate: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ eq: z.tuple([z.unknown(), z.unknown()]) }), z.object({ neq: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ gt: z.tuple([z.unknown(), z.unknown()]) }), z.object({ gte: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ lt: z.tuple([z.unknown(), z.unknown()]) }), z.object({ lte: z.tuple([z.unknown(), z.unknown()]) }),
    z.object({ in: z.tuple([z.unknown(), z.array(z.unknown())]) }), z.object({ has: z.tuple([z.unknown(), z.unknown()]) }), z.object({ exists: z.string() }),
    z.object({ and: z.array(Predicate) }), z.object({ or: z.array(Predicate) }), z.object({ not: Predicate }),
  ]),
);

// ---- wait rule (D14) -----------------------------------------------------------
export const WaitRule = z.object({
  anchor: z.string(),                       // "now" | "appointment.starts_at" | any datetime path
  offset: z.string(),                       // "+4h" | "-1d" | "day_of@08:00" | "day_before@19:00" | "day_after@09:00"
  tz: z.enum(["contact", "company"]).default("contact"),
  guard: z.object({ min_lead: z.string(), fallback: z.string() }).optional(),
  // a daily window in that zone: a computed time before `earliest` moves later to it (the same day); after `latest`, earlier to it. "Four hours before a 7am call" lands at 8am, not 3am.
  earliest: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  latest: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
export type WaitRule = z.infer<typeof WaitRule>;

export const Validity = z.object({
  anchor: z.enum(["before_event", "after_event", "unanchored"]).default("unanchored"),
  min_lead: z.string().optional(),          // before_event: must send at least this long before starts_at
  max_lag: z.string().optional(),           // after_event: must send within this long after starts_at
});
export const OnStale = z.enum(["skip", "substitute", "escalate"]);

// ---- nodes (the instruction set, 02-data-model §10) ----------------------------
/** Who a Slack post appears from: a name and an emoji / image URL, or a list of icons one is picked from per post. */
const Persona = z.object({ name: z.string().optional(), icon: z.union([z.string(), z.array(z.string())]).optional() });
const TagList = z.union([z.string(), z.array(z.string()).min(1)]);
const base = { id: z.string().min(1), title: z.string().optional(), only_if: Predicate.optional() };   // only_if: the step runs when this holds, else it is skipped (a sometimes-step on the chart)   // title: the words the dashboard shows for this step, when the generic ones are not good enough
export const Schedule = z.object({ every: z.string().regex(/^\d+(m|h|d)$/).optional(), at: z.string().regex(/^\d{2}:\d{2}$/).optional(), days: z.array(z.number().int().min(1).max(7)).optional(), day_of_month: z.number().int().min(1).max(28).optional(), for: z.enum(["company", "closer"]).default("company") })
  .refine((s) => !!s.every !== !!s.at, { message: "a schedule is either every <interval> or at <time>, not both, not neither" });
export type Schedule = z.infer<typeof Schedule>;
export const Node = z.discriminatedUnion("type", [
  // event: what starts it. "schedule" starts it from the clock instead: `every` ("60m", "2h", "1d") or `at` ("18:00" company time, with `days`
  // 1..7 Mon..Sun and/or `day_of_month`); `for` says what each run is about: the company (one run) or each closer (one run per closer).
  z.object({ ...base, type: z.literal("trigger"), event: z.string(), match: Predicate.optional(), schedule: Schedule.optional() }),
  z.object({ ...base, type: z.literal("wait"), rule: WaitRule }),
  // Waits for an inbound reply (woken the minute one arrives) or until `timeout`; follows the edge labeled "timeout" if none, else exits `no_reply`.
  // until: a wait rule that caps the deadline (D58, G7: the booking text's reply wait ends an hour before the call, so a call booked two hours out still gets its reminders).
  z.object({ ...base, type: z.literal("wait_for_reply"), timeout: z.string(), channel: z.enum(["sms", "email", "any"]).default("any"), settle: z.string().default("90s"), until: WaitRule.optional() }),   // settle: after the first reply, wait this long for the rest of what they are typing (D47)
  // Waits for a team member's tap on ONE Slack message (D53): `of` names it ("tag:<tag>" as a slack_post remembered it, or the id of a slack_post in this run); only `emojis` count,
  // on that very message. The tap lands under `into` as { reaction, user, user_name, ts }. With `timeout`, silence continues with it null so a branch can handle it; without, it waits for the tap.
  // blocking: false (D58) arms a listener instead and the run goes straight on: a tap, wherever the run is parked later, jumps it to the edge labeled "tap" (where it was and when it was
  // due are kept, and a `resume` node puts it back); at `until` (a wait rule) the listener disarms, the run takes the edge labeled "until" with `into` null, or when the run reaches an
  // exit first. A run holds one listener at a time.
  z.object({ ...base, type: z.literal("wait_for_reaction"), of: z.string(), emojis: z.array(z.string().min(1)).min(1), timeout: z.string().optional(), into: z.string().default("reaction"), blocking: z.boolean().default(true), until: WaitRule.optional() }),
  // Returns a run its listener pulled away (D58) to the step it was parked on, with that step's own due time; with nothing to return to, follows its edge like any step.
  z.object({ ...base, type: z.literal("resume") }),
  // kind: "human" reads like a person wrote it and always respects dark hours; "transactional" is an automated receipt ("you're booked") the company may let through at any hour
  // ghl_template: the CRM's own SMS snippet / email builder template id (or a {{crm.*}} binding); when set and found, the team's copy in the CRM wins over `template` (D30)
  z.object({ ...base, type: z.literal("send_sms"), template: z.string(), ghl_template: z.string().optional(), kind: z.enum(["human", "transactional"]).default("human"), validity: Validity.optional(), on_stale: OnStale.default("skip"), substitute_template: z.string().optional() }),
  z.object({ ...base, type: z.literal("send_email"), subject: z.string(), template: z.string(), ghl_template: z.string().optional(), kind: z.enum(["human", "transactional"]).default("human"), validity: Validity.optional(), on_stale: OnStale.default("skip"), substitute_template: z.string().optional() }),
  // Sends a Documents & Contracts template to the contact from `sender` (a CRM user id), and records it in the agreements ledger. Skipped in shadow like every CRM write.
  z.object({ ...base, type: z.literal("send_document"), template: z.string(), sender: z.string().optional(), name: z.string().optional() }),
  // Nudges the contact's owner (CRM assignee, else crm.default_closer): a Slack DM when the owner can be found in Slack, else the fallback channel with an @mention; plus a CRM task on the contact when `task` is set.
  z.object({ ...base, type: z.literal("notify_owner"), template: z.string(), fallback_channel: z.string().optional(), task: z.object({ title: z.string(), due: z.string().default("+1d") }).optional(), as: Persona.optional() }),
  // `as`: the display name and icon the post appears under (Zapier-style), blank = the app; editable on the step
  // thread_of: the id of an earlier slack_post in this run; this one goes into that message's thread (the scorecard under the call post)
  // tag: remember this post under a name (rendered, e.g. "eod-reminder:{{user.id}}:{{user.eod.day}}") so a later run can thread under it: thread_of "tag:<that name>"
  // react: an emoji put on the parent post (thread_of) once this reply is up, e.g. white_check_mark
  z.object({ ...base, type: z.literal("slack_post"), channel: z.string(), fallback_channel: z.string().optional(), template: z.string(), as: Persona.optional(), thread_of: z.string().optional(), thread_only: z.boolean().default(false), tag: z.string().optional(), react: z.union([z.string(), z.array(z.string())]).optional(),
    offer: z.array(z.string().min(1)).optional(), unreact: z.object({ of: z.string(), emojis: z.array(z.string().min(1)).min(1) }).optional(), react_on: z.object({ of: z.string(), emojis: z.array(z.string().min(1)).min(1) }).optional() }),   // react_on: reactions put on ANOTHER post ("tag:…" or a node id), e.g. the outcome on the question the team was asked (D58)   // fallback_channel: posts there when `channel` is an unbound binding (an attention channel that falls back to the bookings channel, D58)   // offer: reactions added to this post for a person to tap (D45); unreact: the bot's own reactions taken off that post ("tag:…" or a node id) once a person has decided   // thread_only: a reaction or note on an existing post; nothing when that post is not there
  // An HTTP call out: Airtable, a Zap or Make scenario, Apps Script, anything with a URL. Headers and body are templates; {{secret.<key>}} resolves
  // in headers and body only here and is never written to the ledger. The response (JSON when it is) lands in vars.<into>.
  z.object({ ...base, type: z.literal("webhook"), url: z.string(), method: z.enum(["POST", "PUT", "PATCH", "GET", "DELETE"]).default("POST"), headers: z.record(z.string()).default({}), body: z.unknown().optional(), into: z.string().optional(), on_error: z.enum(["fail", "skip"]).default("fail") }),
  // The hourly sweep as a step: which checks run, where its alerts go. Findings become alerts through the same announcer as everything else.
  z.object({ ...base, type: z.literal("health_check"), checks: z.record(z.boolean()).default({}), channel: z.string().optional(), as: Persona.optional() }),
  // Bookable slots on the calendars: fewer than min_slots in the next days is a low-availability alert. In a run about a booking, only that booking's calendar is read.
  z.object({ ...base, type: z.literal("availability_check"), min_slots: z.number().int().min(0).default(3), days: z.number().int().min(1).max(7).default(7) }),
  // A wrap-up (daily / weekly / monthly numbers) rendered into vars.<into> = { body, period, numbers } and kept in the wrapups ledger; a slack_post after it sends it.
  z.object({ ...base, type: z.literal("report"), kind: z.string(), breakdowns: z.array(z.string()).default([]), sections: z.record(z.boolean()).default({}), into: z.string().default("report") }),
  z.object({ ...base, type: z.literal("classify"), input: z.string(), state: z.string().optional(), domain: z.string(), threshold: z.number().min(0).max(1).default(0.8), into: z.string(),
    question: z.string().optional(), criteria: z.record(z.string()).optional(), ambiguity_max: z.number().min(0).max(1).default(0.8) }),   // question: what Jev is asked about `input`; `state` is context (what we sent)   // criteria: what each option means, in words; ambiguity_max: a reply a careful person would doubt this much goes to a human (D47)
  z.object({ ...base, type: z.literal("branch"), on: z.string().optional() }),
  z.object({ ...base, type: z.literal("check"), when: Predicate, else_exit: z.string(), retry: z.object({ every: z.string(), for: z.string() }).optional() }),   // retry: park and look again every `every` for up to `for` before taking else_exit
  // The contact's tags in one step: `add` goes on, then `remove` comes off. set_tag / remove_tag are the older one-direction forms; installed copies still carry them.
  z.object({ ...base, type: z.literal("tags"), add: TagList.optional(), remove: TagList.optional() }),
  z.object({ ...base, type: z.literal("set_tag"), tag: TagList }),
  z.object({ ...base, type: z.literal("remove_tag"), tag: TagList }),
  // Writes to the CRM contact: a few native fields plus custom fields by id. A field whose rendered value is empty is left alone, never blanked.
  z.object({ ...base, type: z.literal("update_contact"), set: z.object({ first_name: z.string().optional(), last_name: z.string().optional(), phone: z.string().optional(), timezone: z.string().optional(), assign_to: z.string().optional() }).default({}), fields: z.array(z.object({ id: z.string(), value: z.string() })).default([]), clear: z.array(z.string()).default([]) }),
  // A to-do on the CRM contact for a human (rebook this person, call them back). `due` is a duration from now.
  z.object({ ...base, type: z.literal("create_task"), title: z.string(), body: z.string().optional(), due: z.string().default("+1d"), assign_to: z.string().optional() }),
  z.object({ ...base, type: z.literal("note"), template: z.string() }),
  z.object({ ...base, type: z.literal("update_appointment"), set: z.record(z.unknown()) }),
  z.object({ ...base, type: z.literal("update_opportunity"), set: z.record(z.unknown()) }),
  // A card on a CRM pipeline board. One open card per contact per pipeline: re-firing moves/renames it instead of duplicating. Cards hang off the contact's one open opportunity.
  // `status` closes the card (won/lost): the board's terminal column. A closed card no longer counts as the contact's open card on that board.
  z.object({ ...base, type: z.literal("pipeline_card"), pipeline: z.string(), stage: z.string().optional(), name: z.string().optional(), assign_to: z.string().optional(), status: z.enum(["open", "won", "lost", "abandoned"]).optional(), if_missing: z.enum(["create", "skip"]).default("create"), fields: z.array(z.object({ id: z.string(), value: z.string() })).default([]) }),
  // Reads a document (the call transcript by default) against a prompt bound per company ({{prompt.<name>}}), answer stored under vars.<into>.
  // json: the answer is parsed and its fields are addressable ({{vars.notes.summary}}); text: stored as a string.
  // optional: decoration (a congratulations line); when the AI cannot run the step is skipped and the run goes on without the value
  z.object({ ...base, type: z.literal("analyze"), prompt: z.string(), input: z.string().default("{{recording.transcript_text}}"), into: z.union([z.string(), z.array(z.string().min(1)).min(2)]), format: z.enum(["json", "text"]).default("json"), max_tokens: z.number().int().positive().optional(), optional: z.boolean().default(false) }),   // into: one var, or the keys of one object the prompt returns (`["notes", "rubric"]` → vars.notes, vars.rubric from one read)
  // Writes the appointment's outcome on OUR row (showed / noshow / …), the same path the closer's disposition form takes; call.held follows a show.
  z.object({ ...base, type: z.literal("record_outcome"), outcome: z.string(), call_outcome: z.string().optional(), notes: z.string().optional() }),
  // A record on a CRM custom object (payment, sales call, …), upserted by our own key so the CRM's lagging search is never consulted.
  // `properties` values are templates; an empty rendered value is left out. `relate` links the record to other records by association id.
  z.object({ ...base, type: z.literal("crm_record"), object: z.string(), key: z.string(), properties: z.record(z.string()), owner: z.string().optional(),
    relate: z.array(z.object({ association: z.string(), first: z.string(), second: z.string() })).default([]) }),
  // with `when`: value if it holds, else_value otherwise. With `pick`: value is rendered and looked up in it ("{{reply.intent}}" → pick.cancelled), else_value when no key matches.
  z.object({ ...base, type: z.literal("set_var"), key: z.string(), value: z.unknown(), when: Predicate.optional(), pick: z.record(z.unknown()).optional(), else_value: z.unknown().optional() }),
  // A fact for the ledger: one event of type `event` with `data` rendered (a whole "{{path}}" keeps its type, so a boolean stays a boolean). Ours, never the CRM; runs in shadow too. Starts nothing by itself.
  z.object({ ...base, type: z.literal("record"), event: z.string().min(1), data: z.record(z.string()).default({}) }),
  z.object({ ...base, type: z.literal("start_workflow"), workflow: z.string(), with: z.record(z.unknown()).optional() }),
  z.object({ ...base, type: z.literal("pause_runs"), scope: z.enum(["contact", "appointment"]).default("contact") }),
  z.object({ ...base, type: z.literal("exit"), reason: z.string() }),
]);
export type Node = z.infer<typeof Node>;

export const Edge = z.object({ from: z.string(), to: z.string(), when: Predicate.optional(), else: z.boolean().optional(), label: z.string().optional() });
export type Edge = z.infer<typeof Edge>;
/** Edge labels that are not "go on": the reply wait's `timeout`, a listener's `tap` and `until` (D58). */
export const SIDE_LABELS = new Set(["timeout", "tap", "until"]);
/** The edge a step follows when it simply finishes: the first one not labelled as a side path (else the first at all). */
export const onwardEdge = (edges: Edge[]): Edge | undefined => edges.find((e) => !SIDE_LABELS.has(e.label ?? "")) ?? edges[0];

export const Premise = z.object({
  check: z.enum(["none", "appointment_in_future", "appointment_exists", "opportunity_open", "contact_exists"]).default("none"),
});

export const Definition = z.object({
  schema: z.literal(1),
  reentry: z.enum(["once_per_contact", "once_per_appointment", "once_per_opportunity", "once_per_contact_per_window", "always"]),
  reentry_window: z.string().optional(),
  // a template appended to the reentry key ("{{appointment.starts_at}}"): the same appointment at a new time is a new run once the old one has finished; one still in flight keeps the appointment (D20)
  reentry_key: z.string().optional(),
  premise: Premise.default({ check: "none" }),
  nodes: z.array(Node).min(1),
  edges: z.array(Edge),
}).superRefine((d, ctx) => {
  const ids = new Set<string>();
  for (const n of d.nodes) { if (ids.has(n.id)) ctx.addIssue({ code: "custom", message: `duplicate node id ${n.id}` }); ids.add(n.id); }
  for (const e of d.edges) for (const k of ["from", "to"] as const)
    if (!ids.has(e[k])) ctx.addIssue({ code: "custom", message: `edge ${k} ${e[k]} is not a node` });
  if (!d.nodes.some((n) => n.type === "trigger")) ctx.addIssue({ code: "custom", message: "a workflow needs at least one trigger" });
  if (!d.nodes.some((n) => n.type === "exit")) ctx.addIssue({ code: "custom", message: "a workflow needs at least one exit" });
  const hasOut = new Set(d.edges.map((e) => e.from));
  for (const n of d.nodes) if (n.type !== "exit" && !hasOut.has(n.id)) ctx.addIssue({ code: "custom", message: `node ${n.id} (${n.type}) has no outgoing edge` });
  for (const n of d.nodes) if (n.type === "tags" && !n.add && !n.remove) ctx.addIssue({ code: "custom", message: `node ${n.id} (tags) adds nothing and removes nothing` });
  for (const n of d.nodes) if (n.type === "wait_for_reaction" && !n.blocking) {
    const labels = d.edges.filter((e) => e.from === n.id).map((e) => e.label);
    if (!labels.includes("tap")) ctx.addIssue({ code: "custom", message: `node ${n.id} (wait_for_reaction, blocking: false) has no edge labeled "tap"` });
    if (!labels.some((l) => l !== "tap" && l !== "until")) ctx.addIssue({ code: "custom", message: `node ${n.id} (wait_for_reaction, blocking: false) has no edge to go on by` });
  }
});
export type Definition = z.infer<typeof Definition>;

// ---- manifest: every {{binding}} the definition references (D3) --------------------
export type ManifestEntry = { key: string; kind: "secret" | "id" | "text" | "channel" | "number"; required: boolean; resolves?: string; fallback?: string };   // fallback: a channel binding whose only use is a slack_post that posts to `fallback` when it is unbound (D58)
const BINDING_PREFIXES: Record<string, ManifestEntry["kind"]> = { "crm.": "id", "calendar.": "id", "slack.channel.": "channel", "secret.": "secret", "prompt.": "text" };

export function extractManifest(def: Definition): { bindings: ManifestEntry[] } {
  const refs = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)) refs.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(def.nodes); walk(def.edges);
  // an analyze node needs the company's Anthropic key even though no template mentions it
  if (def.nodes.some((n) => n.type === "analyze")) refs.add("secret.anthropic_key");
  // a notify_owner node posts to Slack even without a channel binding (it DMs), so slack.channel.alerts is only the fallback; nothing to add
  const out = new Map<string, ManifestEntry>();
  for (const ref of refs) {
    for (const [prefix, kind] of Object.entries(BINDING_PREFIXES)) {
      if (!ref.startsWith(prefix)) continue;
      // calendar.closer_call.url → binding key calendar.closer_call
      const key = prefix === "calendar." || prefix === "prompt." ? ref.split(".").slice(0, 2).join(".") : prefix === "slack.channel." ? ref.split(".").slice(0, 3).join(".") : ref;
      const required = kind !== "channel";
      out.set(key, { key, kind, required, ...(prefix === "calendar." ? { resolves: "calendars" } : {}) });
    }
  }
  if (!out.has("crm.location_id")) out.set("crm.location_id", { key: "crm.location_id", kind: "id", required: true });
  // a channel that every post falls back from is optional twice over: unbound, the posts still land in the fallback
  const chan = (t?: string) => t && /^\{\{\s*slack\.channel\.[a-zA-Z0-9_]+\s*\}\}$/.test(t) ? t.replace(/[{}\s]/g, "") : undefined;
  const fallbackOf = new Map<string, string | null>();
  for (const n of def.nodes) { if (n.type !== "slack_post") continue; const c = chan(n.channel), f = chan(n.fallback_channel); if (!c) continue; fallbackOf.set(c, fallbackOf.has(c) && fallbackOf.get(c) !== f ? null : f ?? null); }
  for (const [key, fb] of fallbackOf) { const e = out.get(key); if (e && fb && !def.nodes.some((n) => n.type !== "slack_post" && JSON.stringify(n).includes(key)) && !JSON.stringify(def.edges).includes(key)) e.fallback = fb; }
  return { bindings: [...out.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export function parseDefinition(raw: unknown): Definition {
  return Definition.parse(raw);
}
export function indexDefinition(def: Definition) {
  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Edge[]>();
  for (const e of def.edges) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  return { nodes, edgesFrom: (id: string) => out.get(id) ?? [], triggers: def.nodes.filter((n): n is Extract<Node, { type: "trigger" }> => n.type === "trigger") };
}
