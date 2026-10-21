import { PortError, type SchedulingPort } from "@/engine/ports";
import { attemptOnce, failFor, withPolicy } from "../framework/http";
import type { FieldMap } from "../framework/field-map";
import type { Hub } from "../framework/hub";
import type { Version } from "../framework/state";
import type { CanonicalFact, Connection, J, Normalized } from "../framework/types";

/**
 * Calendly, behind the scheduling port. A paid plan is the rule: Calendly signs its webhooks
 * (`Calendly-Webhook-Signature: t=..,v1=<hex HMAC-SHA256>`) with the webhook subscription's signing key. A free plan has
 * no webhooks; it is polled only as an exception, flagged on the connection (mode "polling" and
 * config.free_plan_exception: { by, at, why }); without the flag the poll refuses to run and says so.
 *
 * | Calendly event | Canonical fact |
 * | --- | --- |
 * | invitee.created | appointment.booked (rescheduled_from when it replaces a booking) |
 * | invitee.canceled | appointment.cancelled (rescheduled / rescheduled_to when it was moved) |
 * | invitee_no_show.created / deleted | appointment.status_changed to noshow / back to booked |
 *
 * Shapes from v1's Calendly reads (adapters/calendly/read.ts, verified) and Calendly's webhook docs; the webhook
 * envelope itself is UNVERIFIED against a real delivery (v1 only polled). A booking's id is its scheduled event's uuid.
 * Answers are read by the question's text from config.questions ({ setter: "Who set this call?", ... }); the call type
 * from the field map (object "calendar": the event type's uuid).
 */

export const CALENDLY_BASE = "https://api.calendly.com";
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const uuidOf = (uri: unknown) => (typeof uri === "string" ? uri.split("/").filter(Boolean).pop() ?? "" : "");
const eventOfInvitee = (uri: unknown) => { const p = String(uri ?? "").split("/").filter(Boolean); const i = p.indexOf("scheduled_events"); return i >= 0 ? p[i + 1] ?? "" : ""; };

async function calendly(hub: Hub, conn: Connection, method: "GET" | "POST", pathOrUrl: string, body?: unknown, write = false, confirm?: () => Promise<unknown>): Promise<unknown> {
  const token = conn.credentials.token;
  if (!token) throw new PortError("auth", "the Calendly connection has no token");
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${CALENDLY_BASE}${pathOrUrl}`;
  const out = await withPolicy(hub.http, "Calendly", () => attemptOnce(hub.http, url, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, 20_000), { write, ...(confirm ? { confirm } : {}) });
  if ("confirmed" in out) return out.confirmed;
  if (out.res.status >= 400) throw failFor("Calendly", out.res, `${method} ${new URL(url).pathname}`);
  return out.res.body;
}

/** One booking (the scheduled event and its invitee) as the facts' appointment and contact. */
function bookingOf(event: J, inv: J, map: FieldMap, questions: Record<string, string>) {
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ");
  const qa = (Array.isArray(inv.questions_and_answers) ? inv.questions_and_answers : []) as J[];
  const answerTo = (label: string) => str(qa.find((x) => { const q = norm(String(x.question ?? "")); return q === norm(label) || q.startsWith(norm(label)); })?.answer);
  const answers = Object.fromEntries(Object.entries(questions).map(([k, label]) => [k, answerTo(label)]).filter(([, v]) => v));
  const phone = str(inv.text_reminder_number) ?? (questions.phone ? answerTo(questions.phone) : undefined) ?? str(qa.find((x) => /\bphone\b/i.test(String(x.question ?? "")))?.answer);
  const host = (Array.isArray(event.event_memberships) ? event.event_memberships[0] : undefined) as J | undefined;
  const typeId = uuidOf(event.event_type);
  const kind = map.calendarKind(typeId);
  const [first, ...rest] = String(inv.name ?? "").trim().split(/\s+/);
  const loc = (event.location ?? {}) as J;
  const appointment = Object.fromEntries(Object.entries({
    starts_at: str(event.start_time), ends_at: str(event.end_time), status: event.status === "canceled" ? "cancelled" : inv.no_show ? "noshow" : "booked", calendar_id: typeId, title: str(event.name),
    ...(kind ? { kind, term: { category: kind } } : {}), closer: host ? { email: str(host.user_email)?.toLowerCase(), name: str(host.user_name) } : undefined,
    set_by: answers.setter, answers: Object.keys(answers).length ? answers : undefined, tracking: inv.tracking ?? undefined, meeting_url: str(loc.join_url) ?? str(loc.location),
    reschedule_url: str(inv.reschedule_url), cancel_url: str(inv.cancel_url), booked_at: str(event.created_at), booking_source: answers.setter ? "setter" : "self", provider: "calendly",
  }).filter(([, v]) => v !== undefined));
  const contact = Object.fromEntries(Object.entries({
    email: str(inv.email)?.toLowerCase(), phone, first_name: str(inv.first_name) ?? first, last_name: str(inv.last_name) ?? (rest.length ? rest.join(" ") : undefined), name: str(inv.name), timezone: str(inv.timezone),
  }).filter(([, v]) => v !== undefined));
  return { appointment, contact };
}

/** A Calendly webhook body (or one a poll built the same way) as canonical facts. */
export async function normalizeCalendly(hub: Hub, conn: Connection, body: J, source = "calendly"): Promise<Normalized> {
  const kind = String(body.event ?? "");
  const p = (body.payload ?? {}) as J;
  const at = str(body.created_at) ? new Date(String(body.created_at)) : hub.now();
  const map = await hub.fieldMap(conn.offerId, "calendly");
  const questions = (conn.config.questions ?? {}) as Record<string, string>;
  const learn: Version[] = [];
  const facts: CanonicalFact[] = [];
  if (kind === "invitee_no_show.created" || kind === "invitee_no_show.deleted") {
    const id = eventOfInvitee(p.invitee);
    if (!id) return { facts: [], outcome: "a no-show without its invitee" };
    const prev = await hub.state.version(conn.offerId, "calendly", "appointment", id);
    const to = kind === "invitee_no_show.created" ? "noshow" : "booked";
    facts.push({ offerId: conn.offerId, type: "appointment.status_changed", occurredAt: at, source, dedupeKey: `calendly:${id}:${to}:${at.toISOString()}`, contactId: (prev?.state.contact_id as string | undefined) ?? null, appointmentId: id, payload: { status: { from: to === "noshow" ? "booked" : "noshow", to }, appointment: { status: to }, by: "calendly" } });
    learn.push({ offerId: conn.offerId, provider: "calendly", kind: "appointment", entityId: id, versionAt: at, state: { ...(prev?.state ?? {}), status: to }, updatedAt: hub.now() });
  } else if (kind === "invitee.created" || kind === "invitee.canceled") {
    const event = (p.scheduled_event ?? {}) as J;
    const id = uuidOf(event.uri) || eventOfInvitee(p.uri);
    if (!id) return { facts: [], outcome: "an invitee without its event" };
    const { appointment, contact } = bookingOf(event, p, map, questions);
    const hit = await hub.matchContact(conn.offerId, { email: (contact.email as string | undefined) ?? null, phone: (contact.phone as string | undefined) ?? null });
    const base = { offerId: conn.offerId, occurredAt: at, source, contactId: hit?.id ?? null, appointmentId: id };
    if (kind === "invitee.created") {
      facts.push({ ...base, type: "appointment.booked", dedupeKey: `calendly:${id}:booked`, payload: { appointment, contact, ...(p.old_invitee ? { rescheduled_from: eventOfInvitee(p.old_invitee) } : {}), by: "calendly" } });
    } else {
      const c = (p.cancellation ?? {}) as J;
      facts.push({ ...base, type: "appointment.cancelled", dedupeKey: `calendly:${id}:cancelled`, payload: { appointment: { ...appointment, status: "cancelled" }, contact, status: { from: "booked", to: "cancelled" }, rescheduled: p.rescheduled === true, ...(p.new_invitee ? { rescheduled_to: eventOfInvitee(p.new_invitee) } : {}), cancellation: { by: str(c.canceled_by) ?? null, reason: str(c.reason) ?? null, by_type: str(c.canceler_type) ?? null }, by: "calendly" } });
    }
    learn.push({ offerId: conn.offerId, provider: "calendly", kind: "appointment", entityId: id, versionAt: at, state: { status: appointment.status, invitee: str(p.uri) ?? null, contact_id: hit?.id ?? null }, updatedAt: hub.now() });
  } else {
    return { facts: [], outcome: `ignored ${kind || "an event"}` };
  }
  return { facts, outcome: "facts", commit: async () => { for (const v of learn) await hub.state.putVersion(v); } };
}

export function calendlyScheduling(hub: Hub, conn: Connection): SchedulingPort {
  return {
    async cancel(_c, p) {
      // a cancel that may have gone through is read back: a cancelled event is done, never cancelled twice
      const confirm = async () => { const e = (await calendly(hub, conn, "GET", `/scheduled_events/${encodeURIComponent(p.appointmentId)}`)) as { resource?: J }; return e.resource?.status === "canceled" ? true : undefined; };
      await calendly(hub, conn, "POST", `/scheduled_events/${encodeURIComponent(p.appointmentId)}/cancellation`, { reason: p.reason ?? "" }, true, confirm);
    },
    async setStatus(_c, p) {
      if (p.status !== "noshow") throw new PortError("permanent", `Calendly keeps no "${p.status}" status; only a no-show can be marked`);
      const v = await hub.state.version(conn.offerId, "calendly", "appointment", p.appointmentId);
      const invitee = str(v?.state.invitee);
      if (!invitee) throw new PortError("permanent", `the platform does not know the invitee of Calendly booking ${p.appointmentId}`);
      await calendly(hub, conn, "POST", "/invitee_no_shows", { invitee }, false);
    },
  };
}

/**
 * The free plan's poll (by exception only): the organization's bookings changed since the last look, each built as the
 * webhook Calendly would have sent, through the same normalizer. One listing a run, then each changed event's invitees.
 */
export async function pollCalendly(hub: Hub, conn: Connection): Promise<{ facts: number; refused?: string }> {
  if (conn.mode !== "polling") return { facts: 0, refused: "not in polling mode" };
  const ex = conn.config.free_plan_exception as J | undefined;
  if (!ex || !str(ex.by)) {
    await hub.alert({ offerId: conn.offerId, key: "calendly:polling-unapproved", kind: "connection_config", message: "This offer's Calendly connection is set to poll, but no free-plan exception is recorded on it. A paid plan with webhooks is the rule; the poll does not run until Tyler records the exception.", detail: {} });
    return { facts: 0, refused: "no free-plan exception recorded" };
  }
  const org = conn.externalId;
  if (!org) throw new PortError("permanent", "the Calendly connection has no organization uri");
  const now = hub.now();
  const cursor = (await hub.state.version(conn.offerId, "calendly", "cursor", "poll"))?.versionAt ?? new Date(now.getTime() - 3_600_000);
  const q = new URLSearchParams({ organization: org, min_start_time: new Date(now.getTime() - 86_400_000).toISOString(), max_start_time: new Date(now.getTime() + 90 * 86_400_000).toISOString(), count: "100", sort: "start_time:asc" });
  let facts = 0;
  let next: string | null = `/scheduled_events?${q}`;
  for (let page = 0; next && page < 10; page++) {
    const r = (await calendly(hub, conn, "GET", next)) as { collection?: J[]; pagination?: { next_page?: string | null } };
    for (const e of r.collection ?? []) {
      if (Date.parse(String(e.updated_at ?? 0)) < cursor.getTime() - 60_000) continue;
      const id = uuidOf(e.uri);
      const prev = await hub.state.version(conn.offerId, "calendly", "appointment", id);
      const invs = ((await calendly(hub, conn, "GET", `${String(e.uri)}/invitees?count=10`)) as { collection?: J[] }).collection ?? [];
      const inv = invs.find((i) => i.status === "active") ?? invs[0];
      if (!inv) continue;
      const body = (event: string) => ({ event, created_at: String(e.updated_at ?? now.toISOString()), payload: { ...inv, scheduled_event: e } });
      const built: J[] = [];
      if (!prev && e.status !== "canceled") built.push(body("invitee.created"));
      if (e.status === "canceled" && prev?.state.status !== "cancelled") { if (!prev) built.push(body("invitee.created")); built.push(body("invitee.canceled")); }
      if (inv.no_show && prev?.state.status !== "noshow" && e.status !== "canceled") built.push({ event: "invitee_no_show.created", created_at: String((inv.no_show as J).created_at ?? now.toISOString()), payload: { invitee: inv.uri } });
      for (const b of built) {
        const n = await normalizeCalendly(hub, conn, b, "calendly_poll");
        for (const f of n.facts) { await hub.ingest(f); facts++; }
        await n.commit?.();
      }
    }
    next = r.pagination?.next_page ?? null;
  }
  await hub.state.putVersion({ offerId: conn.offerId, provider: "calendly", kind: "cursor", entityId: "poll", versionAt: now, state: {}, updatedAt: now });
  const every = Number(conn.config.poll_seconds) > 0 ? Number(conn.config.poll_seconds) * 1000 : 120_000;
  await hub.enqueue("calendly_poll", { connectionId: conn.id }, { runAt: new Date(now.getTime() + every), jobKey: `calendly_poll:${conn.id}` });
  return { facts };
}
