import Link from "next/link";
import { notFound } from "next/navigation";
import { company, companyAlerts, companyHealth } from "@/ui/queries";
import { CHECKS, type Finding } from "@/engine/health";
import { ago, badge, stamp } from "@/ui/format";
import { runHealthNowAction, reregisterWebhookAction } from "@/ui/settings-actions";
export const dynamic = "force-dynamic";

/** One company's health: what is wrong right now, what the last sweep saw check by check, and what cleared recently. Read-only; the sweep's settings live on the settings page. */
export default async function HealthPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ note?: string }> }) {
  const { slug } = await params; const sp = await searchParams; const co = await company(slug); if (!co) notFound();
  const [{ open, recent }, h] = await Promise.all([companyAlerts(co.id), companyHealth(co.id)]);
  const results = h.last_result as Finding[];
  const byCheck = new Map<string, Finding[]>(); for (const f of results) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  const resolved = recent.filter((a) => a.resolved_at).slice(0, 20);
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / Health</p>
    <h1>Health</h1>
    {sp.note ? <div className="card ready" style={{ marginBottom: 10 }}><strong>{sp.note}</strong></div> : null}
    <div className="row-wrap">
      <span className={open.length ? "badge b-failed" : "badge b-live"}>{open.length ? `${open.length} open` : "all clear"}</span>
      <span className="muted">Sweep {h.enabled ? `every ${h.every_minutes} min` : "off"} · last {h.last_run_at ? `${stamp(h.last_run_at, co.timezone)} (${ago(h.last_run_at)})` : "never"} · <Link href={`/c/${slug}/settings#health`}>settings</Link></span>
      <form action={runHealthNowAction}><input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={co.id} /><button className="btn" type="submit">Sweep now</button></form>
    </div>
    <h2>Open right now · {open.length}</h2>
    {open.length === 0 ? <div className="empty">Nothing wrong that the engine can see.</div> : <ol className="tl">{open.map((a) => <li key={a.id} className={`tl-row st-${a.level === "error" ? "failed" : "stale"}`}><span className="tl-t">{stamp(a.first_seen, co.timezone)}</span><span className="tl-w">{a.text}{(a.detail as { link?: string }).link ? <> <a href={(a.detail as { link: string }).link} target="_blank" rel="noreferrer">{(a.detail as { link_label?: string }).link_label ?? "Open"} ↗</a></> : null}<span className="tl-d">{a.source} · open {ago(a.first_seen)}{a.announce_count ? ` · said ${a.announce_count}×` : " · not yet announced"}{a.href ? <> · <Link href={a.href}>open</Link></> : null}</span></span></li>)}</ol>}
    <h2>Last sweep, check by check</h2>
    {!h.last_run_at ? <div className="empty">The sweep has not run yet. It runs on the tick when due, or press Sweep now.</div> : <ol className="tl">{CHECKS.map((ck) => { const fs = byCheck.get(ck.id); const off = h.checks[ck.id] === false; const failing = (fs ?? []).filter((f) => !f.ok);
      return <li key={ck.id} className={`tl-row ${off ? "" : !fs ? "" : failing.length ? (failing.some((f) => f.level === "error") ? "st-failed" : "st-stale") : "st-ok"}`}>
        <span className="tl-t" style={{ fontFamily: "var(--sans)", fontSize: 14.5, color: "var(--bone)" }}>{ck.label}</span>
        <span className="tl-w">{off ? <span className="muted">off</span> : !fs ? <span className="muted" title={ck.about}>not applicable</span> : failing.length ? failing.map((f, i) => <div key={i}><span className={badge(f.level === "error" ? "failed" : "stale")}>{f.level}</span> {f.text}{f.fix ? <form id="fix" action={reregisterWebhookAction} style={{ display: "inline", marginLeft: 8 }}><input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={co.id} /><input type="hidden" name="provider" value={f.fix.action.replace("reregister_", "")} /><button className="btn btn-on" type="submit">{f.fix.label}</button></form> : null}</div>) : <span>{fs.length === 1 ? fs[0].text : `${fs.length} fine: ${fs.map((f) => f.text).join(" ")}`.slice(0, 300)}</span>}</span>
      </li>; })}</ol>}
    <h2>Recently resolved</h2>
    {resolved.length === 0 ? <div className="empty">Nothing resolved recently.</div> : <ol className="tl">{resolved.map((a) => <li key={a.id} className="tl-row st-ok"><span className="tl-t">{stamp(a.resolved_at, co.timezone)}</span><span className="tl-w">{a.text}<span className="tl-d">{a.source} · opened {stamp(a.first_seen, co.timezone)} · open for {Math.max(1, Math.round((new Date(a.resolved_at!).getTime() - new Date(a.first_seen).getTime()) / 60e3))} min</span></span></li>)}</ol>}
  </>);
}
