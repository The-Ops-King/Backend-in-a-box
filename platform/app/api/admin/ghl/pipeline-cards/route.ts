import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

type RawOpp = { id: string; name?: string; status: string; pipelineStageId: string; contact?: { id?: string; name?: string; email?: string; tags?: string[] }; contactId?: string };

/**
 * D346: GET ?company=<slug>&pipeline=<GHL pipeline id>: every card on one of the offer's GHL pipelines, any status, with its stage's
 * name and its person's tags (as GHL's search carries them; read from the contact when it does not). Read only: what a clean-up on
 * that board would touch is seen before anything is asked for. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url), slug = u.searchParams.get("company"), pipeline = u.searchParams.get("pipeline");
  if (!slug || !pipeline) return NextResponse.json({ error: "company and pipeline are required" }, { status: 400 });
  try {
    return await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
      if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
      const { adapterCompany: ac } = await loadCompany(c, co.id);
      const pipes = (await ghl<{ pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[] }>(ac.pit, "GET", `/opportunities/pipelines?locationId=${ac.locationId}`)).pipelines ?? [];
      const pipe = pipes.find((p) => p.id === pipeline);
      if (!pipe) return NextResponse.json({ error: "no such pipeline in this offer's GHL" }, { status: 404 });
      const stage = new Map(pipe.stages.map((s) => [s.id, s.name]));
      const opps: RawOpp[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await ghl<{ opportunities?: RawOpp[] }>(ac.pit, "GET", `/opportunities/search?location_id=${ac.locationId}&pipeline_id=${encodeURIComponent(pipeline)}&status=all&limit=100&page=${page}`);
        const got = r.opportunities ?? []; opps.push(...got);
        if (got.length < 100) break;
      }
      const cards = [];
      for (const o of opps) {
        const contactId = o.contact?.id ?? o.contactId ?? null;
        let tags = o.contact?.tags;
        if (!Array.isArray(tags) && contactId) tags = (await ghl<{ contact?: { tags?: string[] } }>(ac.pit, "GET", `/contacts/${contactId}`)).contact?.tags ?? [];
        cards.push({ id: o.id, name: o.contact?.name ?? o.name ?? "", status: o.status, stage: stage.get(o.pipelineStageId) ?? o.pipelineStageId, contact_id: contactId, tags: tags ?? [] });
      }
      return NextResponse.json({ ok: true, pipeline: { id: pipe.id, name: pipe.name }, count: cards.length, cards });
    });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 500) }, { status: 502 }); }
}
