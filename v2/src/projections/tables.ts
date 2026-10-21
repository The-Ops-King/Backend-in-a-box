/**
 * The projection tables' rows, as both stores read and write them. A projection is rebuildable: every row here is made
 * by a projector from the fact log, and nothing else writes it. Rows are keyed (offerId, id).
 */

type J = Record<string, unknown>;

export type ContactRow = {
  offerId: string; id: string; crmId: string | null; phones: string[]; emails: string[]; mergedInto: string | null;
  attrs: J; records: J; agreement: J | null; leadAt: Date | null; firstDialAt: Date | null; speedToLeadMin: number | null; updatedAt: Date;
};
export type AppointmentRow = {
  offerId: string; id: string; contactId: string | null; status: string | null; kind: string | null; startsAt: Date | null; endsAt: Date | null;
  bookedAt: Date | null; bookingSource: string | null; setBy: string | null; closerKey: string | null; reschedules: number;
  outcome: string | null; callOutcome: string | null; outcomeSource: string | null; outcomeAt: Date | null; pendingRead: J | null; attrs: J; updatedAt: Date;
};
export type CallRow = {
  offerId: string; id: string; contactId: string | null; appointmentId: string | null; source: "booking" | "dialer" | "meeting"; kind: string | null;
  booked: boolean; startsAt: Date | null; held: boolean | null; outcome: string | null; repKey: string | null; recordingId: string | null;
  recording: J | null; startedAt: Date | null; endedAt: Date | null; durationSec: number | null; direction: string | null; connected: boolean | null; updatedAt: Date;
};
export type DealRow = {
  offerId: string; id: string; contactId: string | null; kind: "ledger" | "card"; pipeline: string | null; crmId: string | null; stage: string | null;
  status: string | null; ownerKey: string | null; name: string | null; value: number | null; openedAt: Date | null; wonAt: Date | null; lostAt: Date | null;
  seq: number; updatedAt: Date;
};
export type PaymentRow = {
  offerId: string; id: string; contactId: string | null; dealId: string | null; providerPaymentId: string | null; status: "succeeded" | "refunded" | "failed";
  amount: number; currency: string | null; paidAt: Date; product: J; refundOf: string | null; customer: J; linkedBy: string | null; seq: number; updatedAt: Date;
};
export type PersonRow = {
  offerId: string; id: string; name: string | null; email: string | null; slackUserId: string | null; crmUserId: string | null; roles: string[];
  active: boolean; eodDays: string[]; updatedAt: Date;
};
export type DailyFactRow = { offerId: string; id: string; day: string; metric: string; closer: string; setter: string; source: string; n: number; amount: number };

export type Rows = {
  contacts_index: ContactRow; appointments: AppointmentRow; calls: CallRow; deals: DealRow; payments: PaymentRow; people: PersonRow; daily_facts: DailyFactRow;
};
export type ProjTable = keyof Rows;
export const PROJ_TABLES: ProjTable[] = ["contacts_index", "appointments", "calls", "deals", "payments", "people", "daily_facts"];

/** How a column is stored in Postgres. */
export type ColType = "text" | "ts" | "int" | "num" | "bool" | "json" | "textarr";

/** Every column of every projection table, by its row field, in Postgres's name and type (the Postgres store reads and writes through this). */
export const COLUMNS: { [T in ProjTable]: Record<Exclude<keyof Rows[T], "offerId">, ColType> } = {
  contacts_index: { id: "text", crmId: "text", phones: "textarr", emails: "textarr", mergedInto: "text", attrs: "json", records: "json", agreement: "json", leadAt: "ts", firstDialAt: "ts", speedToLeadMin: "int", updatedAt: "ts" },
  appointments: {
    id: "text", contactId: "text", status: "text", kind: "text", startsAt: "ts", endsAt: "ts", bookedAt: "ts", bookingSource: "text", setBy: "text", closerKey: "text",
    reschedules: "int", outcome: "text", callOutcome: "text", outcomeSource: "text", outcomeAt: "ts", pendingRead: "json", attrs: "json", updatedAt: "ts",
  },
  calls: {
    id: "text", contactId: "text", appointmentId: "text", source: "text", kind: "text", booked: "bool", startsAt: "ts", held: "bool", outcome: "text", repKey: "text",
    recordingId: "text", recording: "json", startedAt: "ts", endedAt: "ts", durationSec: "int", direction: "text", connected: "bool", updatedAt: "ts",
  },
  deals: {
    id: "text", contactId: "text", kind: "text", pipeline: "text", crmId: "text", stage: "text", status: "text", ownerKey: "text", name: "text", value: "num",
    openedAt: "ts", wonAt: "ts", lostAt: "ts", seq: "int", updatedAt: "ts",
  },
  payments: {
    id: "text", contactId: "text", dealId: "text", providerPaymentId: "text", status: "text", amount: "num", currency: "text", paidAt: "ts", product: "json",
    refundOf: "text", customer: "json", linkedBy: "text", seq: "int", updatedAt: "ts",
  },
  people: { id: "text", name: "text", email: "text", slackUserId: "text", crmUserId: "text", roles: "textarr", active: "bool", eodDays: "textarr", updatedAt: "ts" },
  daily_facts: { id: "text", day: "text", metric: "text", closer: "text", setter: "text", source: "text", n: "int", amount: "num" },
};

export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * A read of one table: equality on columns (`where`), an array column that holds a value (`has`), and a time column in
 * a range (`range`, from inclusive, to exclusive). Only columns of the table are accepted: the query is data, never SQL.
 */
export type ProjQuery = { where?: Record<string, string | number | boolean | null>; has?: Record<string, string>; range?: { col: string; from?: Date; to?: Date } };

export function checkQuery(table: ProjTable, q: ProjQuery): void {
  const cols = COLUMNS[table] as Record<string, ColType>;
  for (const k of Object.keys(q.where ?? {})) if (!cols[k]) throw new Error(`${table} has no column ${k}`);
  for (const k of Object.keys(q.has ?? {})) if (cols[k] !== "textarr") throw new Error(`${table}.${k} is not a list column`);
  if (q.range && cols[q.range.col] !== "ts") throw new Error(`${table}.${q.range.col} is not a time column`);
}

/** Whether a row matches a read (the memory store's reading of it; the Postgres store compiles the same thing). */
export function matches(row: Record<string, unknown>, q: ProjQuery): boolean {
  for (const [k, v] of Object.entries(q.where ?? {})) if ((row[k] ?? null) !== v) return false;
  for (const [k, v] of Object.entries(q.has ?? {})) if (!(row[k] as string[]).includes(v)) return false;
  if (q.range) {
    const t = row[q.range.col] as Date | null;
    if (!t) return false;
    if (q.range.from && t.getTime() < q.range.from.getTime()) return false;
    if (q.range.to && t.getTime() >= q.range.to.getTime()) return false;
  }
  return true;
}

/** A row as it comes back from either store, in one shape: dates as Date, numbers as number. */
export function normalizeRow<T extends ProjTable>(table: T, raw: Record<string, unknown>): Rows[T] {
  const out: Record<string, unknown> = { offerId: raw.offerId };
  for (const [k, t] of Object.entries(COLUMNS[table] as Record<string, ColType>)) {
    const v = raw[k];
    if (v === undefined || v === null) out[k] = t === "textarr" ? [] : t === "json" && (k === "attrs" || k === "records" || k === "product" || k === "customer") ? {} : null;
    else if (t === "ts") out[k] = v instanceof Date ? new Date(v.getTime()) : new Date(String(v));
    else if (t === "int" || t === "num") out[k] = Number(v);
    else if (t === "json") out[k] = JSON.parse(JSON.stringify(v));
    else if (t === "textarr") out[k] = [...(v as string[])];
    else out[k] = v;
  }
  return out as Rows[T];
}
