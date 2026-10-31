import type { PoolClient } from "pg";
import { many } from "@/db/client";
import { testContactSql } from "./mode";
import { standsSql } from "./held";

/**
 * D268 (Tyler: "they need to know about their sets ... a smart list called 'My closed' ... where they're the follower"). Who set a
 * closing call: whoever booked it through their setter link (`set_by`), and whoever ran the person's triage call before it was
 * booked. Both follow the contact in GHL; a self-booked call with no triage has no setter. Test contacts never count.
 */
export type SetFollow = { appointment_id: string; contact_id: string; ghl_contact_id: string; contact: string; booked_at: Date; status: string;
  setters: { user_id: string; name: string; ghl_user_id: string; why: "set_link" | "triage" }[] };

export async function setsToFollow(c: PoolClient, companyId: string, q: { since: Date; domains: string[]; appointmentId?: string }): Promise<SetFollow[]> {
  const rows = await many<{ appointment_id: string; contact_id: string; ghl_contact_id: string; contact: string; booked_at: Date; status: string;
    by_link: { user_id: string; name: string; ghl_user_id: string } | null; by_triage: { user_id: string; name: string; ghl_user_id: string } | null }>(c, `
    select a.id as appointment_id, a.contact_id, ct.ghl_contact_id, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as contact, a.booked_at, a.status,
      (select json_build_object('user_id', u.id, 'name', u.name, 'ghl_user_id', u.ghl_user_id) from users u
        where u.company_id=a.company_id and u.active and u.ghl_user_id is not null and lower(u.name) = lower(a.set_by) limit 1) as by_link,
      (select json_build_object('user_id', u.id, 'name', u.name, 'ghl_user_id', u.ghl_user_id) from appointments b join company_terms bt on bt.id=b.appointment_term join users u on u.id=b.assigned_user_id
        where b.company_id=a.company_id and b.contact_id=a.contact_id and bt.category='first_call' and ${standsSql("b")} and b.starts_at <= a.booked_at + interval '1 hour'
          and u.active and u.ghl_user_id is not null order by b.starts_at desc limit 1) as by_triage
    from appointments a join company_terms t on t.id=a.appointment_term join contacts ct on ct.id=a.contact_id
    where a.company_id=$1 and t.category='closing' and a.source<>'test' and a.booked_at >= $2 and ct.ghl_contact_id is not null and not ${testContactSql("ct", "$3")}
      and ($4::uuid is null or a.id=$4)
    order by a.booked_at`, [companyId, q.since, q.domains, q.appointmentId ?? null]);
  return rows.map((r) => {
    const setters: SetFollow["setters"] = [];
    if (r.by_link) setters.push({ ...r.by_link, why: "set_link" });
    if (r.by_triage && r.by_triage.user_id !== r.by_link?.user_id) setters.push({ ...r.by_triage, why: "triage" });
    return { appointment_id: r.appointment_id, contact_id: r.contact_id, ghl_contact_id: r.ghl_contact_id, contact: r.contact || "—", booked_at: r.booked_at, status: r.status, setters };
  }).filter((r) => r.setters.length);
}
