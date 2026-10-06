import "./globals.css";
import Link from "next/link";
export const metadata = { title: "Engine · backend in a box", description: "Workflow engine: what is running, what it did, what it would have done." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><head>
    <link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
    <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  </head><body>
    <nav className="nav"><Link className="brand" href="/">backend<span>·</span>in<span>·</span>a<span>·</span>box</Link><div className="nav-links"><Link href="/">Companies</Link><Link href="/api/health">Health</Link></div></nav>
    <main className="wrap">{children}</main>
  </body></html>);
}
