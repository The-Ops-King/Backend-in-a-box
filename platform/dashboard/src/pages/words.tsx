import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, usePage, useAction, type CompanyPage } from "~/api";
import { Crumb, Empty, NameLine, Sec, Skeleton, Tag, toast } from "~/ui/pieces";
import { MessageCard } from "./onboarding";
import type { Message } from "@/onboarding/messages";
import type { TemplatesPage } from "./templates";

/** D178: a company's texts and emails, their words editable (kept as its own, D177); for a template business, its playbook's params too. */
export function Words() {
  const { slug = "" } = useParams();
  const key = ["words", slug];
  const co = usePage<CompanyPage>(["company", slug], `/api/v1/companies/${slug}`, { every: 120_000 });
  const q = usePage<{ messages: Message[] }>(key, `/api/v1/companies/${slug}/messages`, { every: 120_000 });
  const tpl = usePage<TemplatesPage>(["templates"], "/api/v1/templates", { every: 120_000, enabled: co.data?.company.status === "template" });
  if (!q.data || !co.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const mine = tpl.data?.templates.find((t) => t.business === slug);
  const byWf = [...new Set(q.data.messages.map((m) => m.workflow))];
  return <>
    <Crumb items={[{ to: "/app", label: "Companies" }, { to: `/app/c/${slug}`, label: co.data.company.name }]} />
    <NameLine name="Words" />
    <div className="tagline">{co.data.company.status === "template" ? <><Tag kind="warn">template</Tag><span>what a new client on this playbook starts from, once published (Companies → Templates)</span></> : <span>this client's own words: they stay through every template upgrade</span>}</div>
    {mine ? <ParamsEditor playbook={mine.playbook} params={mine.params} /> : null}
    <Sec>Texts and emails</Sec>
    {byWf.length ? byWf.map((wf) => <div key={wf} className="call" style={{ marginTop: 12 }}><b>{wf}</b>{q.data.messages.filter((m) => m.workflow === wf).map((m) => <MessageCard key={m.workflowId + m.nodeId} url={`/api/v1/companies/${slug}/messages`} m={m} invalidate={[key]} />)}</div>) : <Empty>No texts or emails.</Empty>}
  </>;
}

function ParamsEditor({ playbook, params }: { playbook: string; params: unknown }) {
  const [text, setText] = useState(JSON.stringify(params ?? null, null, 2));
  const [err, setErr] = useState<string[] | null>(null);
  useEffect(() => setText(JSON.stringify(params ?? null, null, 2)), [params]);
  const save = useAction<unknown>((v) => api("/api/v1/templates", { method: "POST", json: { playbook, action: "params", params: v } }), [["templates"], ["words"]]);
  if (params == null) return null;
  const go = async () => {
    setErr(null); let v: unknown; try { v = JSON.parse(text); } catch { setErr(["not valid JSON"]); return; }
    try { await save.mutateAsync(v); toast("Params saved; its copies rebuilt with them."); } catch (x) { const b = (x as { body?: { problems?: string[] } }).body; setErr(b?.problems?.length ? b.problems : [(x as Error).message]); }
  };
  return <div className="call form" style={{ marginTop: 12 }}><b>The playbook's params</b><p className="note">Stage and board names, card names, call types, objections: what this playbook's copies are built with. Each client's are made its own (its name in them).</p>
    {err ? <div className="banner warn" style={{ marginTop: 0 }}><ul>{err.map((e) => <li key={e}>{e}</li>)}</ul></div> : null}
    <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} />
    <div><button className="btn" type="button" disabled={save.isPending} onClick={go}>Save the params</button></div></div>;
}
