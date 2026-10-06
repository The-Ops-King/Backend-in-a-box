import { NextResponse } from "next/server";
import { installCompany, type InstallInput } from "@/engine/install";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
export const dynamic = "force-dynamic"; export const maxDuration = 120;
/** POST JSON InstallInput with Authorization: Bearer $CRON_SECRET. Same as the CLI; workflows install OFF unless enable:true. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as Partial<InstallInput>;
  for (const k of ["name", "slug", "timezone", "locationId", "pit"] as const) if (!body[k]) return NextResponse.json({ error: `${k} is required` }, { status: 400 });
  try { return NextResponse.json({ ok: true, ...(await installCompany(body as InstallInput, liveAdapters)) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
