import { useEffect, useState } from "react";
import { api } from "~/api";

export function Login() {
  const [pw, setPw] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [configured, setConfigured] = useState(true);
  const next = new URLSearchParams(location.search).get("next") || "/app";
  useEffect(() => { api<{ signedIn: boolean; configured: boolean }>("/api/v1/session").then((s) => { setConfigured(s.configured); if (s.signedIn) location.replace(next); }).catch(() => undefined); }, [next]);
  const go = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await api("/api/v1/session", { method: "POST", json: { password: pw } }); location.replace(next.startsWith("/") ? next : "/app"); } catch (x) { setErr((x as Error).message); setBusy(false); } };
  return <div className="login"><h1>backend in a box</h1><p>{configured ? "The operator's password." : "No password is set on the server yet: set DASHBOARD_PASSWORD and redeploy."}</p>
    <form className="form" onSubmit={go}><label>Password<input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={!configured} /></label>
      {err ? <div className="banner warn">{err}</div> : null}
      <button className="submit" type="submit" disabled={busy || !pw || !configured}>Sign in</button></form></div>;
}
