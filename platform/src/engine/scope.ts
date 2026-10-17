import type { PoolClient } from "pg";
import { one } from "@/db/client";
import type { Adapters, Company } from "@/adapters/types";
import type { CompanyRow } from "./context";
import { emitEvent } from "./dispatch";
import { effectiveMode, handlerMode } from "./mode";
import { raise } from "./alerts";

/**
 * D117: a company installed into a CRM location that belongs to another business acts only on its own people. With a scope
 * tag (`scope.tag`), a person is in scope when GHL carries the tag on them, or when they booked on one of the company's mapped
 * calendars (every ledger appointment is on one: `applyAppointment` keeps no other), or submitted one of its own forms (D122).
 * Without one, everyone is, as before.
 * GHL tags are lowercase; the compare ignores case so a tag typed "Dating" at install is the same tag.
 */
export const SCOPE_KEY = "scope.tag";
export const scopeTag = (bindings: Record<string, string>): string | null => bindings[SCOPE_KEY]?.trim().toLowerCase() || null;
export const carriesTag = (tags: string[] | null | undefined, tag: string) => (tags ?? []).some((t) => t.trim().toLowerCase() === tag);
/** The rule in SQL over a contacts row aliased `ct`; `tag` is a text parameter (null: no scope, everyone passes). */
/** D122: someone who submitted one of the company's own forms is its person too, like a booker (in ghost the tag is only what would have been written). */
export const scopeSql = (ct: string, tag: string) =>
  `(${tag}::text is null or exists (select 1 from unnest(${ct}.tags) st(t) where lower(st.t) = ${tag}::text) or exists (select 1 from appointments sa where sa.contact_id=${ct}.id)
    or exists (select 1 from events sf where sf.company_id=${ct}.company_id and sf.contact_id=${ct}.id and sf.event_type='form.submitted'))`;

/** The company's scope tag read alone, for a path that has no bindings in hand. */
export const companyScopeTag = async (c: PoolClient, companyId: string): Promise<string | null> =>
  (await one<{ value: Buffer }>(c, "select value from bindings where company_id=$1 and key=$2", [companyId, SCOPE_KEY]))?.value.toString("utf8").trim().toLowerCase() || null;

/** The replica's answer: tagged as last seen, or booked. */
export async function inScope(c: PoolClient, contactId: string, tag: string | null): Promise<boolean> {
  if (!tag) return true;
  return !!(await one(c, `select 1 from contacts ct where ct.id=$1 and ${scopeSql("ct", "$2")}`, [contactId, tag]));
}

/**
 * The tagged search cannot show a removal (the person simply stops coming back), so before anything new starts for someone in
 * scope by the tag alone, GHL is asked. A tag gone there takes them out: the replica takes GHL's tags (the poll will never diff
 * this person again, so nothing is swallowed), `scope.left` is recorded, and nothing starts. Nothing is deleted. A booker needs
 * no read; a CRM that does not answer leaves the replica's word standing.
 */
export async function stillInScope(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, contactId: string, tag: string | null): Promise<boolean> {
  if (!tag) return true;
  const row = await one<{ ghl: string | null; tagged: boolean; booked: boolean }>(c, `select ct.ghl_contact_id as ghl, exists (select 1 from unnest(ct.tags) st(t) where lower(st.t)=$2) as tagged,
    exists (select 1 from appointments sa where sa.contact_id=ct.id) or exists (select 1 from events sf where sf.company_id=ct.company_id and sf.contact_id=ct.id and sf.event_type='form.submitted') as booked
    from contacts ct where ct.id=$1`, [contactId, tag]);
  if (!row) return false;
  if (row.booked) return true;
  if (!row.tagged) return false;
  if (!row.ghl) return true;
  let live: Awaited<ReturnType<Adapters["read"]["getContact"]>>;
  try { live = await adapters.read.getContact(ac, row.ghl); } catch { return true; }
  if (!live || carriesTag(live.tags, tag)) return true;
  await c.query("update contacts set tags=$2, updated_at=now() where id=$1", [contactId, live.tags]);
  await emitEvent(c, { company_id: co.id, contact_id: contactId, opportunity_id: null, appointment_id: null, event_type: "scope.left", source: "ghl_poll", data: { tag, by: "tag_removed" } });
  return false;
}

/**
 * A booker brought into scope by their booking gets the tag in GHL, so the CRM agrees with the engine and the tagged poll sees
 * them. Real or ghost is decided as every write the engine makes for its workflows is (D52, D92): `effectiveMode` over the rung
 * of the workflows answering the booking (`handlerMode`). In ghost (or test, for someone who is not a test contact) nothing is
 * written and the would-have is recorded as a tag step records it (`tag.added`, ghost). A refusal does not hold the booking
 * up (they are in scope by it either way): it is an alert, so a person can tag them by hand.
 */
export async function tagIntoScope(c: PoolClient, co: CompanyRow, ac: Company, adapters: Adapters, bindings: Record<string, string>, contactId: string, appointmentId: string, tag: string): Promise<"tagged" | "ghost" | "failed" | "no_crm_id"> {
  const ct = await one<{ ghl: string | null; name: string | null }>(c, "select ghl_contact_id as ghl, nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),'') as name from contacts where id=$1", [contactId]);
  if (!ct?.ghl) return "no_crm_id";   // a Calendly invitee the CRM has not shown yet: in scope by the booking; nothing to tag
  const base = { company_id: co.id, contact_id: contactId, opportunity_id: null, appointment_id: appointmentId, event_type: "tag.added", source: "engine" };
  if ((await effectiveMode(c, co.id, contactId, await handlerMode(c, co.id, "appointment.booked"), bindings)) === "ghost") {
    await emitEvent(c, { ...base, data: { tag, ghost: true, by: "scope" } });
    return "ghost";
  }
  try { await adapters.write.addTag(ac, ct.ghl, tag); }
  catch (e) {
    await raise(c, { companyId: co.id, key: `scope:tag:${contactId}`, level: "warning", source: "engine", href: `/app/c/${co.slug}`,
      text: `${ct.name ?? ct.ghl} booked a call but could not be tagged ${tag} in GHL (${String((e as Error).message).slice(0, 160)}); they are in scope by the booking. Tag them by hand.`,
      detail: { contact_id: contactId, ghl_contact_id: ct.ghl, tag } });
    return "failed";
  }
  await c.query("update contacts set tags = array(select distinct unnest(tags || $2::text[])) where id=$1", [contactId, [tag]]);
  await emitEvent(c, { ...base, data: { tag, by: "scope" } });
  return "tagged";
}
