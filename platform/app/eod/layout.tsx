export const metadata = { title: "End of day" };
/** The closer's page stands alone: no nav, no link to anything but their own day. Auth comes later; until then the link is the door and it opens on this only. */
export default function EodLayout({ children }: { children: React.ReactNode }) {
  return <main className="wrap eod-wrap">{children}</main>;
}
