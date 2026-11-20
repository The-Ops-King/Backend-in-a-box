/**
 * D358: whether booking row `a` is the one a Sales Call keyed `key` belongs to: its slot is that key, or its id is and no call that
 * happened on that slot was kept apart from it (a held call copied off when the booking moved on owns its slot; the booking that
 * moved keeps the source's id but not that call). An offer that never keeps held calls has no such rows, so this reads as before.
 */
export const ownsKey = (a: string, key: string) =>
  `(${a}.slot_key = ${key} or (${a}.external_id = ${key} and not exists (select 1 from appointments h where h.held_from = ${a}.id and h.slot_key = ${key})))`;
