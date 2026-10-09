import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, dashboardPassword, openPath, sessionSecret, verifySession } from "@/engine/session";

/**
 * One door for the operator's dashboard and its JSON API: a signed session cookie. The clock, the admin endpoints,
 * the webhooks and the closer's end-of-day link keep their own keys and are not behind it.
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (openPath(pathname)) return NextResponse.next();
  const ok = await verifySession(req.cookies.get(COOKIE)?.value, sessionSecret());
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: dashboardPassword() ? "sign in first" : "DASHBOARD_PASSWORD is not set on the server" }, { status: dashboardPassword() ? 401 : 503 });
  const to = req.nextUrl.clone(); to.pathname = "/app/login"; to.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(to);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
