import Link from "next/link";
/** The operator's dashboard: every page under / and /c/<slug> gets the nav. The closer's page (/eod) does not, on purpose: their link shows their day and nothing else. */
export default function DashLayout({ children }: { children: React.ReactNode }) {
  return (<>
    <nav className="nav"><Link className="brand" href="/">backend<span>·</span>in<span>·</span>a<span>·</span>box</Link><div className="nav-links"><Link href="/">Companies</Link><Link href="/api/health">Health</Link></div></nav>
    <main className="wrap">{children}</main>
  </>);
}
