import { NextResponse } from "next/server";
import { installCompany, type InstallInput } from "@/engine/install";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { asOperator } from "@/db/client";
import { finishByHand } from "@/onboarding/install";
export const dynamic = "force-dynamic"; export const maxDuration = 120;
/** POST JSON InstallInput with Authorization: Bearer $CRON_SECRET. Same as the CLI; workflows install OFF unless enable:true. `pit` may be omitted on a re-install (the stored token is kept). D334: an offer still in onboarding leaves it (active, in ghost), as the wizard's install step would. */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json()) as Partial<InstallInput>;
  for (const k of ["name", "slug", "timezone", "locationId"] as const) if (!body[k]) return NextResponse.json({ error: `${k} is required` }, { status: 400 });
  try {
    const out = await installCompany(body as InstallInput, liveAdapters);
    const onboarded = await asOperator((c) => finishByHand(c, body.slug!));
    return NextResponse.json({ ok: true, ...out, ...(onboarded ? { onboarding: "finished: active, in ghost" } : {}) });
  }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
