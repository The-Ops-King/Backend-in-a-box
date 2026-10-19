import { useState } from "react";
import { Link } from "react-router-dom";
import { api, usePage, useAction } from "~/api";
import { Sec, Tag, toast } from "~/ui/pieces";
import { ago } from "~/fmt";
import type { Release } from "@/playbooks/template-business";

export type TemplatesPage = { templates: { playbook: string; name: string; about: string; business: string | null; params: unknown; release: Release | null }[] };

/** D150: on the Companies page: each playbook's template business, made, edited and published from here. */
export function Templates() {
  const q = usePage<TemplatesPage>(["templates"], "/api/v1/templates", { every: 120_000 });
  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const act = useAction<{ playbook: string; action: string }, { release?: Release }>((v) => api("/api/v1/templates", { method: "POST", json: v }), [["templates"], ["companies"]]);
  if (!q.data) return null;
  const run = async (playbook: string, action: "create" | "publish") => {
    if (action === "publish" && !confirm("Publish? Every new client on this playbook starts from these words, params and settings. Clients already set up are not touched.")) return;
    setProblems((p) => ({ ...p, [playbook]: [] }));
    try { const r = await act.mutateAsync({ playbook, action }); toast(action === "create" ? "Template business made." : `Published v${r.release?.version}.`); }
    catch (x) { const b = (x as { body?: { problems?: string[] } }).body; setProblems((p) => ({ ...p, [playbook]: b?.problems?.length ? b.problems : [(x as Error).message] })); }
  };
  return <>
    <Sec small="what each new client on a playbook starts from: edit its words and params, then publish">Templates</Sec>
    <div className="rows">{q.data.templates.map((t) => <div key={t.playbook} className="row noicon" style={{ alignItems: "start" }}>
      <span className="mid"><span className="nm">{t.name}</span>
        <span className="sub">{t.release ? <Tag kind="ok">v{t.release.version} published {ago(t.release.published_at)}</Tag> : <Tag>never published: new clients start from the code's defaults</Tag>}
          {t.business ? <><Link to={`/app/c/${t.business}`}>workflows</Link><Link to={`/app/c/${t.business}/words`}>words and params</Link></> : null}</span>
        {problems[t.playbook]?.length ? <div className="banner warn"><strong>Not published:</strong><ul>{problems[t.playbook].map((p) => <li key={p}>{p}</li>)}</ul></div> : null}
        {t.release?.notes.length ? <span className="sub">{t.release.notes.length} placeholder{t.release.notes.length === 1 ? "" : "s"} left for each client to write</span> : null}</span>
      <span style={{ display: "flex", gap: 6 }}>{t.business ? <button className="btn" type="button" disabled={act.isPending} onClick={() => run(t.playbook, "publish")}>Publish</button>
        : <button className="btn" type="button" disabled={act.isPending} onClick={() => run(t.playbook, "create")}>Make the template business</button>}</span>
    </div>)}</div>
  </>;
}
