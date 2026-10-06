import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companyPayments, contactsByEmailOrName } from "@/ui/queries";
import { linkPaymentAction } from "@/ui/actions";
import { badge, when } from "@/ui/format";
export const dynamic = "force-dynamic";

const money = (v: string | number | null | undefined, cur = "USD") => v == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(Number(v));

export default async function PaymentsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; for?: string }> }) {
  const { slug } = await params; const sp = await searchParams; const co = await company(slug); if (!co) notFound();
  const rows = await companyPayments(co.id);
  const unlinked = rows.filter((p) => p.link_status === "unlinked");
  const matches = sp.q && sp.for ? await contactsByEmailOrName(co.id, sp.q) : [];
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / Payments</p>
    <h1>Payments</h1>
    <p className="sub">Every payment the processor reported, linked to a person or waiting to be. Webhook address for Whop: <span className="mono">/api/webhooks/whop/{co.id}</span></p>

    <h2>Unlinked · {unlinked.length}</h2>
    {unlinked.length === 0 ? <div className="empty">Nothing waiting. Every payment found its person.</div> : unlinked.map((p) => (
      <div key={p.id} className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 20 }}>{money(p.amount, p.currency)}</strong><span className={badge(p.status)}>{p.status}</span><span className="muted">{when(p.paid_at, co.timezone)}</span>
          <span className="mono muted">{p.whop_payment_id}</span>
        </div>
        <div className="body">Checkout said: <strong>{p.customer_email ?? "no email"}</strong> · {p.customer_phone ?? "no phone"} · member {p.whop_member_id ?? "—"}</div>
        <form method="get" style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }} className="form">
          <input type="hidden" name="for" value={p.id} />
          <input name="q" defaultValue={sp.for === p.id ? sp.q : ""} placeholder="Find the contact by email or name" style={{ flex: 1, minWidth: 260, font: "inherit", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--hair)", background: "var(--ink-deep)", color: "var(--bone)" }} />
          <button className="btn" type="submit">Search</button>
        </form>
        {sp.for === p.id && (matches.length === 0 ? <div className="body muted">No contact matches “{sp.q}”.</div> : (
          <div className="body" style={{ display: "grid", gap: 6 }}>{matches.map((m) => (
            <form key={m.id} action={linkPaymentAction} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="paymentId" value={p.id} /><input type="hidden" name="contactId" value={m.id} />
              <span>{m.name ?? "(no name)"} <span className="muted mono">{m.email ?? ""}</span></span>
              <button className="btn btn-on" type="submit">Link this payment to them</button>
            </form>))}</div>
        ))}
      </div>
    ))}

    <h2>Ledger</h2>
    {rows.length === 0 ? <div className="empty">No payments yet.</div> :
    <div className="tbl"><table><thead><tr><th>When</th><th>Contact</th><th>Amount</th><th>Kind</th><th>Status</th><th>Running total</th><th>Linked by</th><th>Provider id</th></tr></thead><tbody>
      {rows.map((p) => (<tr key={p.id}>
        <td>{when(p.paid_at, co.timezone)}</td>
        <td>{p.contact_id ? <Link href={`/c/${slug}/contacts/${p.contact_id}`}>{p.contact ?? "contact"}</Link> : <span className="bad">unlinked</span>}</td>
        <td>{money(p.amount, p.currency)}</td><td>{p.kind ? <span className="badge b-type">{p.kind}</span> : "—"}</td><td><span className={badge(p.status === "succeeded" ? "sent" : p.status)}>{p.status}</span></td>
        <td>{p.running_total == null ? "—" : <>{money(p.running_total, p.currency)}{p.contract_value ? <span className="muted"> / {money(p.contract_value, p.currency)}</span> : null}</>}</td>
        <td className="muted">{p.linked_by ?? "—"}</td><td className="mono muted">{p.whop_payment_id}</td>
      </tr>))}
    </tbody></table></div>}
  </>);
}
