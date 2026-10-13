import type { PoolClient } from "pg";
import { many } from "@/db/client";

/**
 * D104: the booking card's intake lines are the company's own. One line: its label and where its value comes from, a CRM
 * contact field by the name the company bound it under (`field`: crm.field_contact_<name>) or a booking answer by the
 * name its calendar maps the question to (`answer`: appointment.answers.<name>); `plus` is a second value from the same
 * place, appended after one space (Hair's "hair_loss hair_loss_stage").
 */
export type IntakeLine = { label: string; field?: string; answer?: string; plus?: string };
export const BOOKING_CARD_KEY = "booking_card.intake";

/** What a company bound, read leniently: a malformed setting is no lines, never a failed booking card. */
export function intakeLines(bindings: Record<string, string>): IntakeLine[] {
  const raw = bindings[BOOKING_CARD_KEY];
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((l): l is IntakeLine => !intakeProblem(l)) : []; } catch { return []; }
}

export function intakeProblem(l: unknown): string | null {
  if (!l || typeof l !== "object") return "a line is an object { label, field | answer, plus? }";
  const { label, field, answer, plus } = l as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim()) return "a line needs a label";
  if ((field === undefined) === (answer === undefined)) return `"${label}": exactly one of field or answer`;
  for (const [k, v] of [["field", field], ["answer", answer], ["plus", plus]] as const) if (v !== undefined && (typeof v !== "string" || !v.trim())) return `"${label}": ${k} is a name`;
  return null;
}

const shown = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (Array.isArray(v)) return v.length ? v.join(", ") : undefined;
  return String(v);
};

/** `*Label:* value` per line, `—` for an empty value, joined by newlines; written to match the card's fixed lines byte for byte. */
export function intakeText(lines: IntakeLine[], fields: Record<string, unknown>, answers: Record<string, unknown> | undefined): string {
  return lines.map((l) => {
    const from = l.field !== undefined ? fields : answers ?? {};
    const name = (l.field ?? l.answer)!;
    return `*${l.label}:* ${shown(from[name]) ?? "—"}${l.plus !== undefined ? ` ${shown(from[l.plus]) ?? ""}` : ""}`;
  }).join("\n");
}

/** The dashboard's example: the company's own labels, each with a placeholder for the value. */
export function intakeExample(lines: IntakeLine[]): string {
  const words = (s: string) => `[${s.replace(/_/g, " ").toLowerCase()}]`;
  return lines.map((l) => `*${l.label}:* ${words(l.label)}${l.plus !== undefined ? ` ${words(l.plus)}` : ""}`).join("\n");
}

/** The four lines Call booked's card carried for every company before D104: Hair's intake questions. */
export const HAIR_INTAKE: IntakeLine[] = [
  { label: "Hair loss", field: "hair_loss", plus: "hair_loss_stage" },
  { label: "Noticing for", field: "noticing_for" },
  { label: "Commit to routine", field: "commit_routine" },
  { label: "Work situation", field: "work_situation" },
];

/**
 * D104 backfill: a company that bound Hair's hair_loss field gets those four lines as its setting, so its card reads as
 * before once its untouched Call booked copy upgrades. Only where the setting was never written: `[]` (no lines) stays.
 * Runs in the migration and again in front of every template install, so it can never land after the template.
 */
export async function backfillBookingCard(c: PoolClient, companyId?: string): Promise<string[]> {
  const value = JSON.stringify(HAIR_INTAKE);
  const rows = await many<{ company_id: string }>(c, `insert into bindings (company_id, key, kind, value)
      select b.company_id, $1, 'text', convert_to($2, 'UTF8') from bindings b
      where b.key='crm.field_contact_hair_loss' and ($3::uuid is null or b.company_id=$3)
    on conflict (company_id, key) do nothing returning company_id`, [BOOKING_CARD_KEY, value, companyId ?? null]);
  for (const r of rows) await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'binding.set','binding',$2,$3,$4)", [r.company_id, BOOKING_CARD_KEY, { set: false }, { kind: "text", value, by: "D104 backfill" }]);
  return rows.map((r) => r.company_id);
}
