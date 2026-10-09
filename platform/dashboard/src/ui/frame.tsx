import { Link, Outlet, useNavigate } from "react-router-dom";
import { api } from "~/api";

/** The operator's frame: a thin line on top (where you are, sign out), then the page in one panel. The closer's page does not use it. */
export function Frame() {
  const nav = useNavigate();
  return <>
    <div className="top"><Link className="brand" to="/app">backend · in · a · box</Link><button type="button" className="out" onClick={async () => { await api("/api/v1/session", { method: "DELETE" }); nav("/app/login"); }}>Sign out</button></div>
    <main className="wrap"><div className="page"><Outlet /></div></main>
  </>;
}
