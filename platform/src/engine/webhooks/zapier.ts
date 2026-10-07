import type { PaymentInput } from "../payments";
import type { RecordingInput } from "../recordings";

/**
 * Payments forwarded by a Zap (Whop → Zapier → Webhooks by Zapier → us) when the processor's own webhooks are out of
 * reach. The Zap maps fields; names are accepted in snake_case or camelCase. Idempotency is the transaction id, same
 * as the direct webhook, so a Zap replay is a no-op.
 */
export function parseZapierPayment(body: Record<string, unknown>): { ok: true; input: PaymentInput } | { ok: false; why: string } {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = body[k]; if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim(); } return undefined; };
  const id = pick("transaction_id", "transactionId", "payment_id", "paymentId", "id");
  if (!id) return { ok: false, why: "transaction_id is required (it is what makes a replayed Zap harmless)" };
  const rawAmount = pick("amount", "final_amount", "total");
  const cleaned = rawAmount?.replace(/[^0-9.-]/g, "") ?? "";
  const amountNum = cleaned === "" ? NaN : Number(cleaned);
  if (!Number.isFinite(amountNum)) return { ok: false, why: `amount is not numeric: ${rawAmount ?? "(missing)"}` };
  const statusRaw = (pick("status", "event", "type") ?? "succeeded").toLowerCase();
  const status: PaymentInput["status"] = /fail|declin/.test(statusRaw) ? "failed" : /refund|charge ?back|dispute/.test(statusRaw) ? "refunded" : "succeeded";
  const paidRaw = pick("paid_at", "paidAt", "created_at", "createdAt", "date");
  const paidAt = paidRaw && !Number.isNaN(Date.parse(paidRaw)) ? new Date(paidRaw) : paidRaw && /^\d{10,13}$/.test(paidRaw) ? new Date(Number(paidRaw) * (paidRaw.length === 10 ? 1000 : 1)) : new Date();
  return { ok: true, input: {
    providerPaymentId: id, provider: (pick("provider", "processor") ?? "whop").toLowerCase(),
    amount: status === "refunded" ? -Math.abs(amountNum) : amountNum, currency: pick("currency") ?? "USD", status, paidAt,
    email: pick("email", "customer_email", "customerEmail", "user_email"), phone: pick("phone", "customer_phone", "customerPhone"), memberId: pick("member_id", "memberId", "whop_user_id", "whopUserId", "user_id"),
    raw: { via: "zapier", plan: pick("plan", "plan_id", "product"), metadata: body.metadata ?? undefined },
  } };
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/**
 * Recordings forwarded by a Zap (Fathom → Zapier → us). Zapier flattens arrays, so invitees may arrive as one
 * "Name <email>, Name <email>" string, a list of emails, or an array of objects; the transcript as a block of text
 * or an array of lines. Every email-shaped token counts as an attendee; staff are subtracted later from the roster.
 */
export function parseZapierRecording(body: Record<string, unknown>): { ok: true; input: RecordingInput } | { ok: false; why: string } {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = body[k]; if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim(); } return undefined; };
  const id = pick("recording_id", "recordingId", "meeting_id", "meetingId", "id");
  if (!id) return { ok: false, why: "recording_id is required (it is what makes a replayed Zap harmless)" };
  const whenOf = (v?: string) => { if (!v) return undefined; if (/^\d{10,13}$/.test(v)) return new Date(Number(v) * (v.length === 10 ? 1000 : 1)); const t = Date.parse(v); return Number.isNaN(t) ? undefined : new Date(t); };
  const startedAt = whenOf(pick("started_at", "startedAt", "recording_start_time", "start_time", "startTime", "scheduled_start_time", "created_at"));
  if (!startedAt) return { ok: false, why: "started_at is required and must be a date" };
  const endedAt = whenOf(pick("ended_at", "endedAt", "recording_end_time", "end_time", "endTime"));
  const minutesRaw = pick("duration_minutes", "durationMinutes"), secondsRaw = pick("duration_seconds", "durationSeconds");
  const durationMin = minutesRaw && Number.isFinite(Number(minutesRaw)) ? Math.round(Number(minutesRaw)) : secondsRaw && Number.isFinite(Number(secondsRaw)) ? Math.round(Number(secondsRaw) / 60) : endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 60000) : undefined;
  const invitees: RecordingInput["invitees"] = [];
  const addInvitee = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(addInvitee); return; }
    if (v && typeof v === "object") { const r = v as Record<string, unknown>; const email = typeof r.email === "string" ? r.email.toLowerCase().trim() : undefined; const name = typeof r.name === "string" ? r.name.trim() : undefined; if (email || name) invitees.push({ name, email, isExternal: typeof r.is_external === "boolean" ? r.is_external : undefined }); return; }
    if (typeof v !== "string") return;
    // "Jane Doe <jane@x.com>, bob@y.com" or a bare list of emails
    for (const part of v.split(/[,;\n]+/)) {
      const m = part.match(EMAIL_RE); if (!m) { const name = part.trim(); if (name && !/@/.test(name)) invitees.push({ name }); continue; }
      const name = part.replace(EMAIL_RE, "").replace(/[<>()"]/g, "").trim() || undefined;
      for (const email of m) invitees.push({ name, email: email.toLowerCase() });
    }
  };
  for (const k of ["invitees", "calendar_invitees", "attendees", "invitee_emails", "inviteeEmails", "invitee_email", "inviteeEmail", "invitee_names", "inviteeNames"]) if (body[k] !== undefined) addInvitee(body[k]);
  const recordedByRaw = body.recorded_by ?? body.recordedBy;
  const recordedBy = recordedByRaw && typeof recordedByRaw === "object" ? { name: String((recordedByRaw as Record<string, unknown>).name ?? "") || undefined, email: String((recordedByRaw as Record<string, unknown>).email ?? "").toLowerCase() || undefined }
    : { email: pick("recorded_by_email", "recordedByEmail", "recorder_email", "host_email")?.toLowerCase() ?? (typeof recordedByRaw === "string" ? recordedByRaw.match(EMAIL_RE)?.[0]?.toLowerCase() : undefined), name: pick("recorded_by_name", "recordedByName", "recorder_name", "host_name") ?? (typeof recordedByRaw === "string" && !/@/.test(recordedByRaw) ? recordedByRaw : undefined) };
  const tRaw = body.transcript ?? body.transcript_text ?? body.transcriptText;
  let transcript: RecordingInput["transcript"];
  if (Array.isArray(tRaw)) transcript = tRaw.map((l) => { const r = (l ?? {}) as Record<string, unknown>; const sp = r.speaker; const speaker = typeof sp === "string" ? sp : String((sp as Record<string, unknown> | undefined)?.display_name ?? "Speaker"); return { speaker, email: typeof (sp as Record<string, unknown> | undefined)?.matched_calendar_invitee_email === "string" ? String((sp as Record<string, unknown>).matched_calendar_invitee_email).toLowerCase() : undefined, text: String(r.text ?? ""), timestamp: typeof r.timestamp === "string" ? r.timestamp : undefined }; });
  else if (typeof tRaw === "string" && tRaw.trim()) transcript = tRaw.split(/\r?\n/).filter((l) => l.trim()).map((line) => { const m = /^\s*(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?([^:]{1,60}):\s*(.*)$/.exec(line); return m ? { speaker: m[2].trim(), text: m[3], timestamp: m[1] } : { speaker: "Speaker", text: line.trim() }; });
  return { ok: true, input: {
    provider: (pick("provider", "source") ?? "fathom").toLowerCase(), externalId: id, title: pick("title", "meeting_title", "meetingTitle"), startedAt, endedAt, durationMin,
    url: pick("url", "recording_url", "recordingUrl"), shareUrl: pick("share_url", "shareUrl") ?? pick("url", "recording_url", "recordingUrl"),
    recordedBy, invitees, transcript, summary: pick("summary", "default_summary", "defaultSummary"),
    raw: { via: "zapier", transcript_url: pick("transcript_url", "transcriptUrl") },
  } };
}
