import { DateTime } from "luxon";
import type { Node } from "./definition";
import { render, resolvePath } from "./template";
import { templateWords } from "./describe";

/**
 * A made-up but complete context, so the dashboard can show what a message LOOKS like ("Payment received: $1,500 /
 * Name: Jane Doe / …") instead of the template behind it. Nothing here is real; it is an example, not a preview.
 */
export function exampleContext(company: { name: string; timezone: string }, bindings: Record<string, string> = {}, now = DateTime.now()): Record<string, unknown> {
  const tz = company.timezone || "America/New_York";
  const n = now.setZone(tz);
  const call = n.plus({ days: 1 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
  const firstBooked = n.minus({ days: 3 }).set({ hour: 11, minute: 0 });
  const person = (name: string, email: string, ghl: string) => ({ name, first_name: name.split(" ")[0], email, ghl_user_id: ghl, slack_user_id: null, mention: `@${name}` });
  const allan = person("Allan P", "allan@example.com", "USER1"), luis = person("Luis", "luis@example.com", "USER2");
  const crm: Record<string, string> = { location_id: "LOCATION" };
  for (const [k, v] of Object.entries(bindings)) if (k.startsWith("crm.")) crm[k.slice(4)] = v;
  const prompt: Record<string, string> = {};
  for (const [k, v] of Object.entries(bindings)) if (k.startsWith("prompt.")) prompt[k.slice(7)] = v;
  const slack = { channel: Object.fromEntries(Object.entries(bindings).filter(([k]) => k.startsWith("slack.channel.")).map(([k, v]) => [k.slice("slack.channel.".length), v])) };
  const link = (u: string) => u;
  return {
    now: n.toISO(),
    company: { name: company.name, timezone: tz },
    contact: {
      id: "contact-id", ghl_contact_id: "abc123", first_name: "Jane", last_name: "Doe", name: "Jane Doe", phone: "+1 602 555 0101", email: "jane@example.com", timezone: tz, tags: ["stat-booked"], attributes: {},
      fields: { setter: "Luis", setter_owner: "Luis", lead_source: "instagram", utm_source: "instagram", hair_loss: "thinning at the crown", appointment_date: call.toISODate() },
      paid: true, payments_count: 1, cash_collected: 1500, first_paid_at: n.toISO(), agreement_signed: true, agreement_sent: true,
      owner: { ...allan, inherited: false }, closer: { ...allan, from: "closer card" }, setter: luis,
      first_booked_at: firstBooked.toISO(), days_to_close: 3, revenue: 4000, source: "instagram", fetched_at: n.toISO(), stale: undefined,
    },
    appointment: {
      id: "appointment-id", external_id: "appt123", source: "ghl", starts_at: call.toISO(), ends_at: call.plus({ minutes: 45 }).toISO(), status: "confirmed", self_booked: false, set_by: "Luis",
      term: { name: "Closing call", category: "closing" }, closer: { id: "u1", ...allan }, answers: { "Phone Number": "+1 602 555 0101", "What is your biggest hair concern?": "thinning at the crown" },
      reschedule_url: link("https://example.com/reschedule"), cancel_url: link("https://example.com/cancel"), tracking: { utm_source: "instagram" }, cancelled_by: "contact", cancel_reason: "schedule conflict", outcome: "showed",
    },
    opportunity: { id: "opp-id", status: "open", contract_value: 4000, opened_at: firstBooked.toISO() },
    cards: {
      closer: { id: "opp123", stage: "STAGE", name: "Jane Doe -- Scheduled", owner: allan },
      setter: { id: "opp456", stage: "STAGE", name: "Jane Doe -- Set", owner: luis },
    },
    event: {
      amount: 1500, kind: "deposit", running_total: 1500, prior_total: 0, contract_value: 4000, outstanding: 2500, cleared: false, provider_payment_id: "pay_123", paid_at: n.toISO(),
      status: { from: "confirmed", to: "showed" }, outcome: "showed", tag: "stat-booked", appointment_matched: true, recording_id: "rec-id",
    },
    recording: {
      id: "rec-id", provider: "fathom", external_id: "123456", title: "Jane Doe <> Allan P", started_at: n.minus({ hours: 2 }).toISO(), ended_at: n.minus({ hours: 1, minutes: 22 }).toISO(), duration_min: 38, duration_sec: 2280,
      url: link("https://fathom.video/calls/123456"), share_url: link("https://fathom.video/share/abc123"), recorded_by: { name: "Allan P", email: "allan@example.com" }, closer: allan, caller: allan,
      invitees: [{ name: "Jane Doe", email: "jane@example.com" }], invitee_names: "Jane Doe", transcript_text: "Allan: Thanks for making the time, Jane. Tell me what you have noticed…", has_transcript: true,
      summary: "Jane has seen thinning at the crown for a year and wants to act before it spreads.", matched_by: "invitee email", analysis: {},
      kind: "meeting", direction: "outbound", status: "connected", connected: true, led_to_booking: true,
    },
    agreement: { id: "doc123", name: "Coaching Agreement", status: "completed", sent_at: n.minus({ days: 1 }).toISO(), signed_at: n.toISO(), signer: "Jane Doe" },
    records: { sales_call: { key: "appt123", id: "rec123" }, payment: { key: "pay_123", id: "rec456" } },
    reaction: { reaction: "white_check_mark", user: "U0123", user_name: "Allan Parker", ts: "1700000000.000100" },
    reply: { intent: "confirmed", confidence: 0.92, top_guesses: "confirmed 92%, reschedule request 5%", last_inbound: { body: "Yes, see you then!", at: n.toISO() }, last_outbound: { body: "Hi Jane, you're booked with Allan tomorrow at 2pm.", at: n.minus({ minutes: 10 }).toISO() } },
    user: { id: "user123", name: "Allan Parker", first_name: "Allan", email: "allan@example.com", role: "closer", slack_user_id: "U0123", mention: "<@U0123>", report_url: "https://engine.example/eod/er_abc",
      eod: { day: n.toISODate(), url: "https://engine.example/eod/er_abc", today: { calls: 3, filed: false, line: "• <https://engine.example/eod/er_abc|today>: 3 calls" }, earlier: [{ day: n.minus({ days: 1 }).toISODate(), label: n.minus({ days: 1 }).toFormat("ccc LLL d"), calls: 2, url: "https://engine.example/eod/er_abc?day=" + n.minus({ days: 1 }).toISODate() }], earlier_count: 1,
        earlier_lines: `• <https://engine.example/eod/er_abc?day=${n.minus({ days: 1 }).toISODate()}|${n.minus({ days: 1 }).toFormat("ccc LLL d")}>: 2 calls`, all_lines: `• <https://engine.example/eod/er_abc|today>: 3 calls\n• <https://engine.example/eod/er_abc?day=${n.minus({ days: 1 }).toISODate()}|${n.minus({ days: 1 }).toFormat("ccc LLL d")}>: 2 calls` } },
    vars: {
      lines: "• <https://engine.example/eod/er_abc|today>: 3 calls", kind: "daily", report: { body: "Daily wrap-up · Thu Oct 8\n\nBooked                                   4\nShowed                                  3   75% of 4\nClosed                                  1   33% of 3\nCash collected                     $4,000", period: { start: n.toISODate(), end: n.toISODate() } },
      setter_line: "*Setter:* Luis", booking_kind: "setter", appt_line: `*Appointment:* ${call.toFormat("ccc LLL d · h:mm a ZZZZ")} · marked showed`, call_key: "appt123", min_seconds: 60, booked_flag: "yes", outcome_line: "Connected · 6 min · booked a call", revenue: 4000,
      classify: { call_type: "setting", is_sales_call: true, confidence: 0.9 },
      notes: { summary: "Jane has thinning at the crown and wants to act now. Price was the only hesitation; she will decide with her partner this week.", prospect_situation: "a year of thinning at the crown", pain: ["thinning at the crown", "hats every day"], desire: ["keep what she has", "feel confident at work"], objections: [{ objection: "price", quote: "that's more than I expected", handled: true }], disposition: "follow_up", primary_objection: "price", next_step: "decide with her partner", next_step_date: n.plus({ days: 4 }).toISODate(), digest: "Setting call: qualified, booked a closing call for tomorrow 2pm.", fit_quality: 8 },
      rubric: { overall_score: 8, scores: { rapport: 9, discovery: 8, pain_depth: 7, presentation: 8, objection_handling: 7, close_attempt: 8 }, strengths: ["asked about the timeline before price", "let Jane finish every answer"], misses: ["did not quantify the cost of waiting"], coaching: ["tie the price back to the pain she named"], talk_ratio: "closer 55 / prospect 45" },
      cheer: "Well done Allan: three days from first call to a signed client.",
    },
    calendar: { closer_call: { id: "CAL1", name: "Closing call", url: link("https://example.com/book/closing") }, booking: { id: "CAL2", name: "Intro call", url: link("https://example.com/book/intro") } },
    slack, crm, prompt,
  };
}

/** Unknown keys read as `[key]` instead of throwing, so an example never dies on a path the sample did not think of. */
function tolerant(obj: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(obj, { get(t, k) { if (typeof k !== "string") return undefined; if (k in t) { const v = t[k]; return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? tolerant(v as Record<string, unknown>) : v; } return `[${k.replace(/_/g, " ")}]`; } });
}

export type Example = { text: string; exact: boolean };
/** A message rendered against the example context; when a filter cannot take the sample, the template in words. */
export function exampleOf(template: string, ctx: Record<string, unknown>, tz: string): Example {
  try { return { text: render(template, tolerant(ctx), { tz, companyTz: tz, now: DateTime.fromISO(String(resolvePath(ctx, "now"))) }), exact: true }; }
  catch { return { text: templateWords(template), exact: false }; }
}

/** Every message a node can produce, rendered as an example. */
export function nodeExamples(n: Node, ctx: Record<string, unknown>, tz: string): { label: string; example: Example }[] {
  const ex = (label: string, t: string | undefined) => (t ? [{ label, example: exampleOf(t, ctx, tz) }] : []);
  switch (n.type) {
    case "send_sms": return [...ex("Text", n.template), ...ex("Fallback text", n.substitute_template)];
    case "send_email": return [...ex("Subject", n.subject), ...ex("Email", n.template), ...ex("Fallback email", n.substitute_template)];
    case "slack_post": case "notify_owner": case "note": return ex("Message", n.template);
    case "create_task": return [...ex("Task", n.title), ...ex("Details", n.body)];
    case "pipeline_card": return ex("Card name", n.name);
    case "set_var": return typeof n.value === "string" ? ex(n.key, n.value) : [];
    case "analyze": return ex("What the AI is given", n.input);
    case "webhook": return [...ex("URL", n.url), ...(typeof n.body === "string" ? ex("Body", n.body) : n.body !== undefined ? [{ label: "Body", example: exampleOf(JSON.stringify(n.body, null, 2), ctx, tz) }] : [])];
    case "report": return ex("Which", n.kind);
    default: return [];
  }
}
