"use server";
import { redirect } from "next/navigation";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { closerByToken, loadEodForm, submitEod, type EodAnswers, type CallEntry } from "@/engine/eod";
import { totalsOf, type CallOutcome } from "@/engine/eod-form";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => { const v = s(f, k); return v === "" ? 0 : Number(v.replace(/[,$]/g, "")) || 0; };
const nOrNull = (f: FormData, k: string) => { const v = s(f, k); return v === "" ? null : Number(v.replace(/[,$]/g, "")) || 0; };

/** The closer pressed Submit on their day. Every per-call answer is named c:<appointment id>:<field key>; day answers d:<field key>. */
export async function submitEodAction(f: FormData) {
  const token = s(f, "token"), day = s(f, "day");
  const ids = String(f.get("appointments") ?? "").split(",").filter(Boolean);
  const r = await asOperator(async (c) => {
    const closer = await closerByToken(c, token); if (!closer?.company_id) return { ok: false as const, why: "this link is not for anyone" };
    const fields = await loadEodForm(c, closer.company_id);
    const extraKeys = fields.filter((x) => x.scope === "call" && !x.builtin).map((x) => x.key);
    const calls: CallEntry[] = ids.map((id) => ({
      appointment_id: id, contact_id: s(f, `c:${id}:contact_id`), contact: s(f, `c:${id}:contact`), starts_at: s(f, `c:${id}:starts_at`), href_contact: null, recording_url: null,
      outcome: s(f, `c:${id}:outcome`) as CallOutcome,
      revenue: nOrNull(f, `c:${id}:revenue`), cash: nOrNull(f, `c:${id}:cash`), next_date: s(f, `c:${id}:next_date`) || null, next_steps: s(f, `c:${id}:next_steps`),
      dq_reason: s(f, `c:${id}:dq_reason`), dq_note: s(f, `c:${id}:dq_note`), about: s(f, `c:${id}:about`), notes: s(f, `c:${id}:notes`),
      extra: Object.fromEntries(extraKeys.map((k) => [k, s(f, `c:${id}:${k}`)]).filter(([, v]) => v !== "")),
    }));
    const t = totalsOf(calls);
    const day_answers = Object.fromEntries(fields.filter((x) => x.scope === "day").map((x) => [x.key, s(f, `d:${x.key}`)]).filter(([, v]) => v !== ""));
    // the top numbers are the closer's own when typed, else what their calls add up to
    const answers: EodAnswers = { calls_count: n(f, "calls_count"), closes: s(f, "closes") === "" ? t.closes : n(f, "closes"), deposits: s(f, "deposits") === "" ? t.deposits : n(f, "deposits"), cash: s(f, "cash") === "" ? t.cash : n(f, "cash"), revenue: s(f, "revenue") === "" ? t.revenue : n(f, "revenue"), calls, day_answers };
    return submitEod(c, liveAdapters, { token, day, answers });
  });
  redirect(`/eod/${token}?day=${day}&${r.ok ? `done=${r.recorded}&changes=${r.changes.length}` : `error=${encodeURIComponent(r.why)}`}`);
}
