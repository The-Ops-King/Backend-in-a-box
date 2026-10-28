import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { tokenFor } from "@/engine/eod";
export const dynamic = "force-dynamic";

/**
 * D246 addendum: a missing day's own link that is safe to post. Behind the dashboard's sign-in (middleware: not an open path),
 * so only the operator gets through; it then opens that closer's form on that day. The closer's private link is never in Slack.
 */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; user: string; day: string }> }) {
  const { slug, user, day } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[0-9a-f-]{36}$/i.test(user)) return NextResponse.json({ error: "not a day or a person" }, { status: 400 });
  const token = await asOperator(async (c) => {
    const u = await one<{ id: string }>(c, "select u.id from users u join companies co on co.id=u.company_id where co.slug=$1 and u.id=$2 and u.active", [slug, user]);
    return u ? tokenFor(c, u.id) : null;
  });
  if (!token) return NextResponse.json({ error: "no such person on this offer" }, { status: 404 });
  return NextResponse.redirect(new URL(`/eod/${token}?day=${day}`, req.url), 302);
}
