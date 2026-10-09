/** The pages not yet rebuilt in the React app (settings and the utility lists) keep this thin nav back to the dashboard. */
export default function DashLayout({ children }: { children: React.ReactNode }) {
  return (<>
    <nav className="nav"><a className="brand" href="/app">backend<span>·</span>in<span>·</span>a<span>·</span>box</a><div className="nav-links"><a href="/app">Dashboard</a></div></nav>
    <main className="wrap">{children}</main>
  </>);
}
