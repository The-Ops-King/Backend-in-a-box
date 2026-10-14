import type { SalesCallReport, SalesCallRow } from "./sales-call-backfill";

/** D115: a dry run of the Sales Call history as a page a person reviews before the write: each call, each field with its evidence, and for what is unknown the most likely reading and why. */

const FIELDS: [string, string][] = [["outcome", "Outcome"], ["disposition", "Disposition"], ["call_type", "Call type"], ["booking_source", "Booking source"], ["closer", "Closer"], ["setter", "Setter"],
  ["cash_collected", "Cash collected"], ["contract_value", "Contract value"], ["objection_primary", "Primary objection"], ["next_step", "Next step"], ["recording_url", "Recording"], ["notes", "Notes"]];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const words = (v: string) => v.replace(/_/g, " ");
const money = (v: unknown) => (typeof v === "number" ? `$${v.toLocaleString("en-US")}` : esc(v));

function value(field: string, v: unknown): string {
  if (field === "recording_url") return `<a href="${esc(v)}">${esc(v)}</a>`;
  if (field === "cash_collected" || field === "contract_value") return money(v);
  if (field === "notes") return `<span class="note">${esc(v)}</span>`;
  return `<b>${esc(words(String(v)))}</b>`;
}

function card(r: SalesCallRow): string {
  const head = `<div class="head"><div><h2>${esc(r.contact.name ?? r.contact.email ?? "Unknown")}</h2><div class="sub">${esc(r.call_date)} · ${esc(r.time)} · ${esc(r.calendar)}${r.closer ? ` · ${esc(r.closer)}` : ""}</div></div>
    <div class="tags">${r.kind === "left_slot" ? '<span class="tag moved">slot left by a move</span>' : ""}${r.skipped ? '<span class="tag skip">not written</span>' : r.error ? '<span class="tag err">error</span>' : r.unknown.length ? `<span class="tag unk">${r.unknown.length} unknown</span>` : '<span class="tag ok">all evidenced</span>'}</div></div>`;
  const ids = `<div class="ids">slot ${esc(r.slot_key)}${r.contact.ghl_contact_id ? ` · GHL contact ${esc(r.contact.ghl_contact_id)}` : ""}${r.contact.email ? ` · ${esc(r.contact.email)}` : ""}${r.written ? ` · ${esc(r.written.record)} ${esc(r.written.crm_id)}` : ""}</div>`;
  if (r.skipped) return `<section class="call skipped">${head}${ids}<p class="why">Not written: ${esc(r.skipped)}</p></section>`;
  const unknown = new Map(r.unknown.map((u) => [u.field, u]));
  const lines = FIELDS.filter(([f]) => r.fields[f] !== undefined || unknown.has(f)).map(([f, label]) => {
    if (r.fields[f] !== undefined) {
      const ev = (r.evidence[f] ?? []).map((e) => `<div class="ev"><span class="src">${esc(e.source)}</span> ${esc(e.detail)}</div>`).join("");
      return `<tr><th>${label}</th><td>${value(f, r.fields[f])}</td><td>${ev}</td></tr>`;
    }
    const u = unknown.get(f)!;
    return `<tr class="u"><th>${label}</th><td><span class="blank">blank</span></td><td><div class="likely">Most likely <b>${esc(words(u.likely))}</b></div><div class="ev">because ${esc(u.why)}</div></td></tr>`;
  }).join("");
  const remarks = r.remarks.length ? `<ul class="remarks">${r.remarks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const kept = r.written?.kept.length ? `<p class="why">Left as GHL has it: ${esc(r.written.kept.join("; "))}</p>` : "";
  const err = r.error ? `<p class="why err">${esc(r.error)}</p>` : "";
  return `<section class="call">${head}${ids}<table>${lines}</table>${remarks}${kept}${err}</section>`;
}

export function salesCallReportHtml(reports: SalesCallReport[], opts: { title?: string; generatedAt?: Date } = {}): string {
  const rows = reports.flatMap((r) => r.rows).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.slot_key.localeCompare(b.slot_key));
  const total = (k: string) => reports.reduce((n, r) => n + (r.summary[k] ?? 0), 0);
  const outcomes = [...new Set(reports.flatMap((r) => Object.keys(r.summary)).filter((k) => k.startsWith("outcome_") && k !== "outcome_unknown"))].map((k) => `${words(k.slice(8))} ${total(k)}`).join(" · ");
  const first = reports[0], plans = reports.map((r) => r.plan_id).filter(Boolean) as string[];
  const incomplete = reports.filter((r) => !r.complete).map((r) => r.resume_from);
  const title = opts.title ?? `Sales Calls for review: ${first?.company ?? ""}${first?.closer ? `, ${first.closer}` : ""}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#5d6470;--line:#e3e6eb;--ok:#1a7f4b;--unk:#9a5b00;--err:#b42318;--moved:#4153af;--soft:#fbf6ec}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1b1e23;--ink:#e8eaee;--mute:#9aa2ae;--line:#2c3139;--ok:#4cc38a;--unk:#f0b45a;--err:#ff8a80;--moved:#9aa8ff;--soft:#2a2418}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--mute);margin-bottom:16px}
.summary{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:20px}.summary p{margin:4px 0}
.call{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px}.call.skipped{opacity:.75}
.head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}h2{font-size:17px;margin:0}.sub,.ids{color:var(--mute);font-size:13px}.ids{margin:4px 0 8px;word-break:break-all}
.tag{display:inline-block;font-size:12px;border-radius:999px;padding:2px 8px;border:1px solid currentColor;margin-left:6px}.ok{color:var(--ok)}.unk{color:var(--unk)}.err{color:var(--err)}.skip{color:var(--mute)}.moved{color:var(--moved)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-top:1px solid var(--line)}th{width:140px;color:var(--mute);font-weight:500}td:nth-child(2){width:200px;word-break:break-word}
tr.u td{background:var(--soft)}.blank{color:var(--mute);font-style:italic}.likely{color:var(--unk)}.ev{font-size:13px;color:var(--mute);margin:1px 0}.src{font-weight:600;color:var(--ink)}.note{font-size:13px}
.remarks{margin:8px 0 0;padding-left:18px;color:var(--mute);font-size:13px}.why{margin:8px 0 0;font-size:13px}code{font-size:12px;word-break:break-all}
@media (max-width:640px){table,tbody,tr,th,td{display:block;width:auto}th{border-top:1px solid var(--line);padding-bottom:0}td{border-top:0;padding-top:2px}td:nth-child(2){width:auto}}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="meta">Calls starting ${esc(reports.map((r) => r.from.slice(0, 10)).sort()[0] ?? "")} to ${esc(reports.map((r) => r.to.slice(0, 10)).sort().at(-1) ?? "")} · ${reports.some((r) => r.dry_run) ? "dry run: nothing has been written" : "written"} · made ${esc((opts.generatedAt ?? new Date()).toISOString().slice(0, 16).replace("T", " "))} UTC</div>
<div class="summary"><p><b>${total("calls")}</b> calls · ${total("skipped")} not written · <b>${total("outcome_unknown")}</b> with no evidenced outcome · ${total("unknown_fields")} fields left blank${total("errors") ? ` · <span class="err">${total("errors")} errors</span>` : ""}</p>
<p>Outcomes from evidence: ${esc(outcomes || "none")}</p>
<p>Every value shown is written to GHL with the evidence beside it. A <span class="blank">blank</span> field stays blank in GHL; the "most likely" reading beside it is for you to decide and is not written.</p>
${plans.length ? `<p>Plan${plans.length > 1 ? "s" : ""} to write exactly this: <code>${esc(plans.join(", "))}</code></p>` : ""}
${incomplete.length ? `<p class="err">Not complete: run again from ${esc(incomplete.join(", "))} for the rest.</p>` : ""}
${reports.flatMap((r) => r.errors).map((e) => `<p class="err">${esc(e)}</p>`).join("")}</div>
${rows.map(card).join("\n")}
</main></body></html>
`;
}
