import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
import { provision, printable, summary, type Setup } from "@/adapters/ghl/provision";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D359: POST { company, setup: <a GHL setup, as installs/<offer>/ghl-setup.json>, why, apply = false }: scripts/provision-ghl.ts run
 * here, on the offer's own stored GHL key, for an offer whose GHL was not built from a setup file (PMU's cadence fields). Additive
 * only: it creates what is missing and never changes or deletes what is there (provision.ts). Without `apply` it only reads and
 * says the plan. Audited when it writes. Authorization: Bearer $CRON_SECRET.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; setup?: Partial<Setup>; why?: string; apply?: boolean } | null;
  if (!b?.company || !b.setup || !b.why?.trim()) return NextResponse.json({ error: "company, setup and why are required" }, { status: 400 });
  const setup: Setup = { prefix: "", timezone: "UTC", team: [], hours: { days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" }, pipelines: [], contactFields: [], opportunityFields: [],
    objects: [], associations: [], calendars: [], install: {}, ...b.setup } as Setup;
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { adapterCompany: ac } = await loadCompany(c, co.id);
    const r = await provision(setup, ac.locationId, (m, p, o) => ghl(ac.pit, m, p, o), { apply: b.apply === true });
    if (r.writes.length) await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'ghl.provisioned','company',$2,$3)", [co.id, co.id, { writes: r.writes, why: b.why }]);
    return NextResponse.json({ ok: true, apply: b.apply === true, summary: summary(r.plan), plan: printable(r.plan), writes: r.writes, after: r.after ? summary(r.after) : null, crm: (r.install as { crm?: unknown }).crm ?? {} });
  });
}
