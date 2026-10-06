import Link from "next/link";
import { notFound } from "next/navigation";
import { company, appointment, terms } from "@/ui/queries";
import { badge, when } from "@/ui/format";
import { submitDisposition } from "@/ui/actions";
export const dynamic = "force-dynamic";
export default async function AppointmentPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params; const co = await company(slug); const a = await appointment(id); if (!co || !a || a.company_id !== co.id) notFound();
  const [outcomes, callOutcomes] = await Promise.all([terms(co.id, "appointment_outcome"), terms(co.id, "call_outcome")]);
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / <Link href={`/c/${slug}/appointments`}>Appointments</Link> / {a.contact.trim()}</p>
    <h1>{a.term} · <Link href={`/c/${slug}/contacts/${a.contact_id}`}>{a.contact.trim() || "contact"}</Link></h1>
    <p className="sub">{when(a.starts_at, co.timezone)} · with {a.closer ?? "unassigned"} · GHL <span className={badge(a.ghl_status === "confirmed" ? "active" : "waiting")}>{a.ghl_status}</span></p>
    <div className="grid g2" style={{ alignItems: "start" }}>
      <div className="card">
        {a.dispositioned_at ? (<>
          <h2 style={{ marginTop: 0 }}>Disposition</h2>
          <dl className="kv"><dt>Showed?</dt><dd><strong>{a.outcome}</strong></dd><dt>Call outcome</dt><dd>{a.call_outcome ?? "—"}</dd><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{a.notes || "—"}</dd><dt>Recorded</dt><dd>{when(a.dispositioned_at, co.timezone)}</dd></dl>
          <p className="sub" style={{ marginTop: 12 }}>Submitting again overwrites the outcome and adds new events to the journey.</p>
        </>) : <h2 style={{ marginTop: 0 }}>What happened on this call?</h2>}
        <form action={submitDisposition} className="form">
          <input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="appointmentId" value={a.id} />
          <fieldset><legend>Did they show?</legend>
            {outcomes.map((o) => <label key={o.id}><input type="radio" name="outcome" value={o.id} required /> {o.name}</label>)}
          </fieldset>
          <fieldset><legend>How did the call go? <span style={{ color: "var(--muted)", fontWeight: 400 }}>(if they showed)</span></legend>
            <select name="call_outcome" defaultValue=""><option value="">—</option>{callOutcomes.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </fieldset>
          <fieldset><legend>Notes</legend><textarea name="notes" rows={4} placeholder="Pains, goals, objections, next step" /></fieldset>
          <button className="btn btn-on" type="submit">Save disposition</button>
        </form>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>What this does</h2>
        <p>Writes the outcome onto this appointment in our database (never into GHL), then adds <code>appointment.outcome</code> to the journey. If they showed, also <code>call.held</code> with the call outcome, which is what post-call follow-up triggers on. A no-show here starts no-show recovery.</p>
      </div>
    </div>
  </>);
}
