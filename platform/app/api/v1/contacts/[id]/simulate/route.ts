import { asOperator, one } from "@/db/client";
import { fail, ok, readJson } from "@/api/http";
import { loadCompany } from "@/engine/context";
import { simulate, SIM_ACTIONS, type SimAction } from "@/engine/simulate";
export const dynamic = "force-dynamic";
/** The test harness (D23): stage a step for this person. Nothing reaches the CRM, Calendly or a Zap; refused while live. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const body = await readJson<{ action?: string }>(req);
  if (!body?.action || !(SIM_ACTIONS as readonly string[]).includes(body.action)) return fail(400, `action must be one of ${SIM_ACTIONS.join(", ")}`);
  return asOperator(async (c) => {
    const ct = await one<{ company_id: string }>(c, "select company_id from contacts where id=$1", [id]); if (!ct) return fail(404, "no such contact");
    const { row } = await loadCompany(c, ct.company_id);
    const r = await simulate({ c, company: row, contactId: id }, body.action as SimAction);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,'contact',$3,$4)", [ct.company_id, `simulate.${body.action}`, id, r.ok ? { ...r.detail, runs_started: r.runsStarted, via: "dashboard" } : { refused: r.why }]);
    return r.ok ? ok({ ok: true, runs_started: r.runsStarted, detail: r.detail }) : fail(409, r.why);
  });
}
