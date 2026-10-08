import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companyRecordings, contactsByEmailOrName } from "@/ui/queries";
import { linkRecordingAction } from "@/ui/actions";
import { badge, when } from "@/ui/format";
export const dynamic = "force-dynamic";

export default async function RecordingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; for?: string }> }) {
  const { slug } = await params; const sp = await searchParams; const co = await company(slug); if (!co) notFound();
  const rows = await companyRecordings(co.id);
  const unlinked = rows.filter((r) => r.link_status === "unlinked");
  const matches = sp.q && sp.for ? await contactsByEmailOrName(co.id, sp.q) : [];
  const people = (r: typeof rows[number]) => r.invitees.map((i) => i.name ?? i.email).filter(Boolean).join(", ") || "nobody listed";
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / Recordings</p>
    <h1>Recordings</h1>
    <p className="sub">Every call recording the recorder reported, matched to a person or waiting to be. Two doors land here: Fathom’s own webhook at <span className="mono">/api/webhooks/fathom/{co.id}</span>, or a Zap posting to <span className="mono">/api/webhooks/zapier/{co.id}/recording</span>.</p>

    <h2>Unmatched · {unlinked.length}</h2>
    {unlinked.length === 0 ? <div className="empty">Nothing waiting. Every recording found its person.</div> : unlinked.map((r) => (
      <div key={r.id} className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 20 }}>{r.title ?? "untitled"}</strong><span className="muted">{when(r.started_at, co.timezone)}</span><span className="muted">{r.duration_min ?? "?"} min</span>
          {r.share_url ? <a href={r.share_url} target="_blank" rel="noreferrer">open recording</a> : null}
        </div>
        <div className="body">On the call: <strong>{people(r)}</strong> · recorded by {r.recorded_by_name ?? r.recorded_by_email ?? "—"}</div>
        <div className="body bad">{r.unlinked_reason ?? "no match"}</div>
        <form method="get" style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }} className="form">
          <input type="hidden" name="for" value={r.id} />
          <input name="q" defaultValue={sp.for === r.id ? sp.q : ""} placeholder="Find the contact by email or name" style={{ flex: 1, minWidth: 260, font: "inherit", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--hair)", background: "var(--ink-deep)", color: "var(--bone)" }} />
          <button className="btn" type="submit">Search</button>
        </form>
        {sp.for === r.id && (matches.length === 0 ? <div className="body muted">No contact matches “{sp.q}”.</div> : (
          <div className="body" style={{ display: "grid", gap: 6 }}>{matches.map((m) => (
            <form key={m.id} action={linkRecordingAction} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="recordingId" value={r.id} /><input type="hidden" name="contactId" value={m.id} />
              <span>{m.name ?? "(no name)"} <span className="muted mono">{m.email ?? ""}</span></span>
              <button className="btn btn-on" type="submit">This is their call</button>
            </form>))}</div>
        ))}
      </div>
    ))}

    <h2>All recordings</h2>
    {rows.length === 0 ? <div className="empty">No recordings yet.</div> :
    <div className="tbl"><table><thead><tr><th>When</th><th>Title</th><th>Contact</th><th>Appointment</th><th>Length</th><th>Matched by</th><th>AI read</th><th>Link</th></tr></thead><tbody>
      {rows.map((r) => (<tr key={r.id}>
        <td>{when(r.started_at, co.timezone)}</td>
        <td>{r.title ?? "untitled"}<div className="muted" style={{ fontSize: 12 }}>{people(r)}</div></td>
        <td>{r.contact_id ? <Link href={`/c/${slug}/contacts/${r.contact_id}`}>{r.contact ?? "contact"}</Link> : <span className="bad">unmatched</span>}</td>
        <td>{r.appointment_id ? <Link href={`/c/${slug}/appointments/${r.appointment_id}`}>{when(r.appointment_at, co.timezone)}</Link> : <span className="muted">none</span>}</td>
        <td>{r.duration_min ?? "?"} min{r.has_transcript ? "" : <span className="muted"> · no transcript</span>}</td>
        <td className="muted">{r.linked_by ?? "—"}</td>
        <td>{Object.keys(r.analysis).length ? Object.keys(r.analysis).map((k) => <span key={k} className="badge b-type" style={{ marginRight: 4 }}>{k}</span>) : <span className="muted">—</span>}</td>
        <td>{r.share_url ? <a href={r.share_url} target="_blank" rel="noreferrer">open</a> : <span className="mono muted">{r.external_id}</span>}</td>
      </tr>))}
    </tbody></table></div>}
  </>);
}
