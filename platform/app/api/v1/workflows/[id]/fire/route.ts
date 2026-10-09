import { asOperator, one } from "@/db/client";
import { fail, ok } from "@/api/http";
import { fireNow } from "@/engine/clock";
import { tick } from "@/engine/runner";
import { announceDue } from "@/engine/alerts";
import { liveAdapters } from "@/adapters";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
/** Start a scheduled workflow now ("Sweep now", "send the wrap-up now"): its schedule fires outside its period and the run executes right away. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const w = await asOperator((c) => one<{ company_id: string }>(c, "select company_id from workflows where id=$1", [id])); if (!w) return fail(404, "no such workflow");
  const r = await asOperator((c) => fireNow(c, w.company_id, id));
  let note = r.why ? `Not started: ${r.why}` : `Started ${r.started.length} run${r.started.length === 1 ? "" : "s"}`;
  if (r.started.length) { const t = await tick(liveAdapters, undefined, w.company_id); await asOperator((c) => announceDue(c, liveAdapters)); note += `: ${t.completed} finished, ${t.failed} failed, ${t.waiting} waiting`; }
  return ok({ ok: !r.why, note, started: r.started.length });
}
