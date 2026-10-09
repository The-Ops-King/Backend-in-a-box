import { NextResponse } from "next/server";
import { COOKIE, SESSION_DAYS, dashboardPassword, issueSession, passwordMatches, readCookie, sessionSecret, verifySession } from "@/engine/session";
export const dynamic = "force-dynamic";

const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

/** Am I signed in? Also says when the server has no password yet, so the login page can say what to set. */
export async function GET(req: Request) {
  const ok = await verifySession(readCookie(req.headers.get("cookie"), COOKIE), sessionSecret());
  return NextResponse.json({ signedIn: ok, configured: !!dashboardPassword() });
}

/** Sign in with the one operator password. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  if (!dashboardPassword()) return NextResponse.json({ error: "DASHBOARD_PASSWORD is not set on the server" }, { status: 503 });
  if (!body?.password || !passwordMatches(body.password, dashboardPassword())) {
    await new Promise((r) => setTimeout(r, 400));   // a wrong guess costs a little time
    return NextResponse.json({ error: "That is not the password" }, { status: 401 });
  }
  const token = await issueSession(sessionSecret());
  return NextResponse.json({ ok: true }, { headers: { "set-cookie": cookie(token, SESSION_DAYS * 86_400) } });
}

export async function DELETE() {
  return NextResponse.json({ ok: true }, { headers: { "set-cookie": cookie("", 0) } });
}
