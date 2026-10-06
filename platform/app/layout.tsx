import "./globals.css";
import Link from "next/link";
export const metadata = { title: "Engine" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>
    <nav className="nav"><Link className="brand" href="/">backend<span>·</span>in<span>·</span>a<span>·</span>box</Link><Link href="/">Companies</Link><Link href="/api/health">Health</Link></nav>
    <main className="wrap">{children}</main>
  </body></html>);
}
