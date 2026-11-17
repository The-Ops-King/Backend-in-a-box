import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
import { documentTemplates } from "@/engine/ghl-calendar-clone";
export const dynamic = "force-dynamic";

/** D344: GET ?company=<slug>: the offer's GHL Documents & Contracts templates ({ id, name }), read live. Read only. Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const slug = new URL(req.url).searchParams.get("company");
  if (!slug) return NextResponse.json({ error: "company is required" }, { status: 400 });
  try {
    return await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
      if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
      const { adapterCompany } = await loadCompany(c, co.id);
      return NextResponse.json({ ok: true, templates: await documentTemplates((m, p, o) => ghl(adapterCompany.pit, m, p, o), adapterCompany.locationId) });
    });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 500) }, { status: 502 }); }
}
