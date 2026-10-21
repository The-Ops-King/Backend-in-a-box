import type { Tx } from "@/engine/store";
import { toInstant } from "@/workflow/dates";
import { type Team, repView } from "./derived";
import type { AppointmentRow, CallRow } from "./tables";

/**
 * The named read-only questions `facts.lookup` asks, answered from the projections (v1's lookup.ts, the same filters and
 * answers): a list's { count, any, items, first, last }. Every param arrives rendered; a blank one is no filter. A
 * transcript is not ours to keep: the conversation's words are read from the recorder (`transcripts`, a vendor read).
 */

export type LookupDeps = {
  tx: Tx; offerId: string; contactId: string | null; appointmentId: string | null; now: Date;
  /** The recorder's words for these recordings, by id (a vendor read); absent, a conversation has no transcript_text. */
  transcripts?: (offerId: string, recordingIds: string[]) => Promise<Record<string, string>>;
};

type J = Record<string, unknown>;
const list = (v: unknown) => (typeof v === "string" && v.trim() ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const listOf = (items: J[]) => ({ count: items.length, any: items.length > 0, items, first: items[0] ?? null, last: items.at(-1) ?? null });

/** A time param: an ISO time (what `plus` / `minus` give), or "-7d" / "+30m" from now. */
function time(p: J, k: string, now: Date): Date | null {
  const v = text(p[k]);
  if (!v) return null;
  const rel = /^([+-])(\d+)([mhd])$/.exec(v);
  if (rel) return new Date(now.getTime() + (rel[1] === "-" ? -1 : 1) * Number(rel[2]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[3] as "m" | "h" | "d"]);
  const t = toInstant(v);
  if (!t) throw new Error(`${k} "${v}" is not a time`);
  return t;
}

const appointmentItem = (a: AppointmentRow, team: Team): J => ({
  id: a.id, starts_at: iso(a.startsAt), ends_at: iso(a.endsAt), booked_at: iso(a.bookedAt), status: a.status, kind: a.kind,
  booking_source: a.bookingSource, set_by: a.setBy, source: a.attrs.source ?? null, closer: (repView(a.closerKey, team, a.attrs.closer)?.name as string | undefined) ?? null, outcome: a.outcome,
});

const callKind = (c: CallRow) => (c.source === "dialer" || c.recording?.kind === "phone" ? "phone" : "meeting");
const callItem = (c: CallRow, team: Team): J => {
  const rep = repView(c.repKey, team, c.recording?.rep);
  const ts = String(c.recording?.transcript_status ?? "");
  return {
    id: c.recordingId, external_id: c.recording?.external_id ?? null, provider: c.recording?.provider ?? null, kind: callKind(c), started_at: iso(c.startedAt), ended_at: iso(c.endedAt ?? c.startedAt),
    duration_min: c.durationSec !== null ? Math.round(c.durationSec / 60) : null, duration_sec: c.durationSec, direction: c.direction, status: c.recording?.status ?? null, connected: !!c.connected,
    has_transcript: ts === "ready" || ts === "at_source", caller: (rep?.name as string | undefined) ?? null, caller_email: (rep?.email as string | undefined) ?? null, title: c.recording?.title ?? null, appointment_id: c.appointmentId,
  };
};

export async function answerLookup(d: LookupDeps, query: string, p: J): Promise<J> {
  if (!d.contactId) throw new Error("the run is not about a contact");
  const team: Team = { people: await d.tx.projFind("people", d.offerId) };
  switch (query) {
    case "appointments_for_contact": {
      const t = Object.fromEntries(["booked_since", "booked_until", "starts_since", "starts_until"].map((k) => [k, time(p, k, d.now)]));
      const source = text(p.source || p.booking_source), order = text(p.order) || "starts_at", closer = text(p.closer).toLowerCase();
      if (source && !["setter", "self"].includes(source)) throw new Error(`booking_source is setter or self, not "${source}"`);
      if (!["starts_at", "booked_at"].includes(order)) throw new Error(`order is starts_at or booked_at, not "${order}"`);
      const kinds = list(p.kind), statuses = list(p.status), not = list(p.status_not), exclude = text(p.exclude);
      const within = (v: Date | null, a: Date | null, b: Date | null) => (!a || (!!v && v >= a)) && (!b || (!!v && v <= b));
      const rows = (await d.tx.projFind("appointments", d.offerId, { where: { contactId: d.contactId } })).filter((a) =>
        within(a.bookedAt, t.booked_since!, t.booked_until!) && within(a.startsAt, t.starts_since!, t.starts_until!)
        // a booking is of the kind its calendar says; one that says none is no kind (v1 read none as closing, in code)
        && (!kinds.length || (a.kind !== null && kinds.includes(a.kind))) && (!source || a.bookingSource === source)
        && (!statuses.length || statuses.includes(a.status ?? "")) && !not.includes(a.status ?? "") && (!exclude || a.id !== exclude)
        && (!closer || (() => { const r = repView(a.closerKey, team, a.attrs.closer); return [r?.name, r?.email, r?.ghl_user_id].some((x) => typeof x === "string" && x.toLowerCase() === closer); })()));
      const at = (a: AppointmentRow) => (order === "booked_at" ? a.bookedAt : a.startsAt)?.getTime() ?? 0;
      return listOf(rows.sort((a, b) => at(a) - at(b) || (a.id < b.id ? -1 : 1)).slice(0, 500).map((a) => appointmentItem(a, team)));
    }
    case "calls_for_contact": {
      const since = time(p, "since", d.now), until = time(p, "until", d.now);
      const kind = text(p.kind), connected = text(p.connected), providers = list(p.provider), caller = text(p.caller).toLowerCase();
      if (kind && !["phone", "meeting"].includes(kind)) throw new Error(`kind is phone or meeting, not "${kind}"`);
      if (connected && !["true", "false"].includes(connected)) throw new Error(`connected is true or false, not "${connected}"`);
      const rows = (await d.tx.projFind("calls", d.offerId, { where: { contactId: d.contactId } })).filter((c) => c.recordingId && c.startedAt
        && (!since || c.startedAt >= since) && (!until || c.startedAt <= until) && (!providers.length || providers.includes(String(c.recording?.provider ?? "")))
        && (!kind || callKind(c) === kind) && (!connected || !!c.connected === (connected === "true")));
      const items = rows.sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime() || (a.id < b.id ? -1 : 1)).map((c) => callItem(c, team))
        .filter((c) => !caller || [c.caller, c.caller_email].some((x) => typeof x === "string" && x.toLowerCase() === caller));
      return listOf(items);
    }
    case "call_conversation": {
      // the parts of the conversation a dialer call belongs to: the same caller's connected calls to this person, each
      // starting within gap_min of the one before it ending, chained both ways, in order; a meeting recording is its own whole
      const id = text(p.recording_id), gap = Number(p.gap_min);
      if (!id) throw new Error("call_conversation needs the recording_id of a call");
      if (text(p.gap_min) === "" || !Number.isFinite(gap) || gap < 0) throw new Error(`gap_min is a number of minutes, not "${text(p.gap_min)}"`);
      const mine = await d.tx.projFind("calls", d.offerId, { where: { contactId: d.contactId } });
      const self = mine.find((c) => c.recordingId === id);
      if (!self) throw new Error(`${id} is not a call of this person's`);
      let parts = [self];
      if (callKind(self) === "phone" && self.startedAt) {
        const day = 86_400_000;
        const near = mine.filter((c) => c.recordingId && callKind(c) === "phone" && c.connected && c.repKey === self.repKey && c.startedAt
          && Math.abs(c.startedAt.getTime() - self.startedAt!.getTime()) <= day).sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime() || (a.id < b.id ? -1 : 1));
        const at = near.findIndex((c) => c.recordingId === id);
        if (at >= 0) {
          const end = (c: CallRow) => (c.endedAt ?? c.startedAt!).getTime();
          const joins = (a: CallRow, b: CallRow) => b.startedAt!.getTime() - end(a) <= gap * 60_000;
          let lo = at, hi = at;
          while (lo > 0 && joins(near[lo - 1]!, near[lo]!)) lo--;
          while (hi < near.length - 1 && joins(near[hi]!, near[hi + 1]!)) hi++;
          parts = near.slice(lo, hi + 1);
        }
      }
      const items = parts.map((c) => callItem(c, team));
      const me = parts.findIndex((c) => c.recordingId === id);
      const sec = parts.reduce((n, c) => n + (c.durationSec ?? 0), 0);
      const words = d.transcripts ? await d.transcripts(d.offerId, parts.map((c) => c.recordingId!)) : undefined;
      const transcript = words ? parts.map((c) => words[c.recordingId!]).filter((w) => typeof w === "string" && w !== "").join("\n\n") : "";
      return {
        ...listOf(items), key: String(parts[0]!.recording?.external_id ?? parts[0]!.recordingId), part: me + 1, total_sec: sec, total_min: Math.round(sec / 60),
        later_ready: items.slice(me + 1).filter((c) => c.has_transcript).length, ...(transcript ? { transcript_text: transcript } : {}),
      };
    }
    default: throw new Error(`facts.lookup has no query ${query}`);
  }
}
