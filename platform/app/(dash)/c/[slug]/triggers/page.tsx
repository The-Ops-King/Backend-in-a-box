import { notFound } from "next/navigation";
import { company, triggerCatalog } from "@/ui/queries";
import { EVENT_LABELS } from "@/engine/describe";
export const dynamic = "force-dynamic";

/** Every event the engine can start a workflow from, what it means, where it comes from, and which of this company's workflows use it. Grows as new facts are taught to the engine. */
const SOURCES: Record<string, string> = {
  lead: "the CRM poll (a new contact), a form, or the test harness", appointment: "the booking source poll (GHL calendars or Calendly), or the test harness", call: "a recording (Fathom direct or via a Zap), the disposition form, or a workflow step",
  message: "the CRM poll (inbound texts and emails) and the engine's own sends", payment: "Whop direct or via a Zap, or the ledger", crm: "the CRM poll (tags, stages)", opportunity: "the engine's lifecycle rules", engine: "the engine itself",
};
const START_FROM = new Set(["lead.created", "intake.recorded", "appointment.booked", "appointment.rescheduled", "appointment.status_changed", "appointment.outcome", "call.held", "recording.received", "message.received", "payment.received", "payment.failed", "payment.paid_in_full", "payment.refunded", "tag.added", "tag.removed", "stage.changed", "opportunity.opened", "opportunity.won", "opportunity.lost", "form.submitted", "call.analyzed"]);

export default async function TriggersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const co = await company(slug); if (!co) notFound();
  const rows = await triggerCatalog(co.id);
  const byCat = new Map<string, typeof rows>(); for (const r of rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  return (<>
    <p className="sub"><a href="/app">Companies</a> / <a href={`/app/c/${slug}`}>{co.name}</a> / Triggers</p>
    <h1>What a workflow can start from</h1>
    <p className="sub">Every fact the engine records is an event. A workflow's first step picks one, optionally with a condition ("only closing calls"). The same list is shared by every company; a new kind of fact (a new door, a new node) adds to it for everyone. Events marked <span className="badge b-type">engine</span> are bookkeeping and are not meant to start workflows.</p>
    {[...byCat.entries()].map(([cat, evs]) => <section key={cat}>
      <h2>{cat.replace(/_/g, " ")} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>· comes from {SOURCES[cat] ?? "the engine"}</span></h2>
      <div className="tbl"><table><thead><tr><th>Event</th><th>In plain words</th><th>Used by</th><th>Seen here (30 days)</th></tr></thead><tbody>
        {evs.map((e) => <tr key={e.name}><td className="mono">{e.name}{START_FROM.has(e.name) ? null : <> <span className="badge b-type">engine</span></>}</td><td>{EVENT_LABELS[e.name] ?? e.name}</td>
          <td>{e.workflows.length ? e.workflows.map((w) => <div key={w.id}><a href={`/app/c/${slug}/w/${w.id}`}>{w.name}</a>{w.enabled ? "" : <span className="muted"> (off)</span>}</div>) : <span className="muted">—</span>}</td><td>{e.seen}</td></tr>)}
      </tbody></table></div>
    </section>)}
  </>);
}
