import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { installUrl, publicBase, sharedManifest, sharedSlackApp } from "@/engine/slack-app";
export const dynamic = "force-dynamic";

/**
 * D251, the shared Slack app. GET (no company): its manifest, to make the app once. GET ?company=<slug>: also that offer's
 * "Add to Slack" link (an hour) and which app its Slack runs on now. Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = publicBase();
  if (!base) return NextResponse.json({ error: "PUBLIC_URL is not set on the server" }, { status: 503 });
  const app = sharedSlackApp(), slug = new URL(req.url).searchParams.get("company");
  const out: Record<string, unknown> = { configured: !!app, manifest: sharedManifest(base) };
  if (!slug) return NextResponse.json(out);
  const co = await asOperator((c) => one<{ id: string; app: string | null; team_id: string | null }>(c, "select co.id, s.app, s.team_id from companies co left join slack_connections s on s.company_id=co.id where co.slug=$1", [slug]));
  if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
  return NextResponse.json({ ...out, company: slug, slack: co.app ? { app: co.app, team_id: co.team_id } : null, install_url: app ? installUrl(co.id, app, base) : null });
}
