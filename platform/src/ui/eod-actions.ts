"use server";
import { redirect } from "next/navigation";
import { asOperator } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { submitEod, type EodAnswers, type CallEntry } from "@/engine/eod";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => { const v = s(f, k); return v === "" ? 0 : Number(v.replace(/[,$]/g, "")) || 0; };
const nOrNull = (f: FormData, k: string) => { const v = s(f, k); return v === "" ? null : Number(v.replace(/[,$]/g, "")) || 0; };

/** The closer pressed Submit on their day. Every per-call block is named by its appointment id. */
export async function submitEodAction(f: FormData) {
  const token = s(f, "token"), day = s(f, "day");
  const ids = String(f.get("appointments") ?? "").split(",").filter(Boolean);
  const calls: CallEntry[] = ids.map((id) => ({
    appointment_id: id, contact_id: s(f, `c:${id}:contact_id`), contact: s(f, `c:${id}:contact`), starts_at: s(f, `c:${id}:starts_at`), href_contact: null,
    attendance: s(f, `c:${id}:attendance`) as CallEntry["attendance"], outcome: s(f, `c:${id}:outcome`) as CallEntry["outcome"],
    revenue: nOrNull(f, `c:${id}:revenue`), cash: nOrNull(f, `c:${id}:cash`), next_date: s(f, `c:${id}:next_date`) || null, next_steps: s(f, `c:${id}:next_steps`),
    pains: s(f, `c:${id}:pains`), goals: s(f, `c:${id}:goals`), objections: s(f, `c:${id}:objections`), notes: s(f, `c:${id}:notes`), recording_url: null,
  }));
  const answers: EodAnswers = { calls_count: n(f, "calls_count"), closes: n(f, "closes"), cash: n(f, "cash"), revenue: n(f, "revenue"), calls, general_notes: s(f, "general_notes") };
  const r = await asOperator((c) => submitEod(c, liveAdapters, { token, day, answers }));
  redirect(`/eod/${token}?day=${day}&${r.ok ? `done=${r.recorded}&changes=${r.changes.length}` : `error=${encodeURIComponent(r.why)}`}`);
}
