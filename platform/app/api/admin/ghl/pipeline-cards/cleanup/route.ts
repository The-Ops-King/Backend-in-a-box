import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { ghl } from "@/adapters/ghl/client";
export const dynamic = "force-dynamic"; export const maxDuration = 300;

type RawOpp = { id: string; name?: string; status: string; pipelineStageId: string; monetaryValue?: number; contact?: { id?: string; name?: string; tags?: string[] }; contactId?: string };

/**
 * D346: POST { company, pipeline, tag, delete_cards: true, remove_tag?, expect, why, dryRun = true } with Authorization: Bearer $CRON_SECRET:
 * on one GHL pipeline of the offer, the cards whose person has `tag` are deleted, and `remove_tag` comes off those people. Nothing
 * else on the board or on them changes. The dry run lists exactly those cards. Applied, it acts only when the cards found are
 * `expect` many (what the dry run showed), and every card is written to the audit log before it is deleted (deleting cannot be undone).
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { company?: string; pipeline?: string; tag?: string; delete_cards?: boolean; remove_tag?: string; expect?: number; why?: string; dryRun?: boolean } | null;
  if (!b?.company || !b.pipeline || !b.tag?.trim() || b.delete_cards !== true || !b.why?.trim()) return NextResponse.json({ error: "company, pipeline, tag, delete_cards: true and why are required" }, { status: 400 });
  const dry = b.dryRun !== false;
  try {
    return await asOperator(async (c) => {
      const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [b.company]);
      if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
      const { adapterCompany: ac } = await loadCompany(c, co.id);
      const pipe = ((await ghl<{ pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[] }>(ac.pit, "GET", `/opportunities/pipelines?locationId=${ac.locationId}`)).pipelines ?? []).find((p) => p.id === b.pipeline);
      if (!pipe) return NextResponse.json({ error: "no such pipeline in this offer's GHL" }, { status: 404 });
      const opps: RawOpp[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await ghl<{ opportunities?: RawOpp[] }>(ac.pit, "GET", `/opportunities/search?location_id=${ac.locationId}&pipeline_id=${encodeURIComponent(pipe.id)}&status=all&limit=100&page=${page}`);
        const got = r.opportunities ?? []; opps.push(...got); if (got.length < 100) break;
      }
      const want = b.tag!.trim().toLowerCase();
      const hit: Array<RawOpp & { contact_id: string | null; tags: string[] }> = [];
      for (const o of opps) {
        const contact_id = o.contact?.id ?? o.contactId ?? null;
        let tags = o.contact?.tags;
        if (!Array.isArray(tags) && contact_id) tags = (await ghl<{ contact?: { tags?: string[] } }>(ac.pit, "GET", `/contacts/${contact_id}`)).contact?.tags ?? [];
        if ((tags ?? []).some((t) => t.toLowerCase() === want)) hit.push({ ...o, contact_id, tags: tags ?? [] });
      }
      const stage = new Map(pipe.stages.map((s) => [s.id, s.name]));
      const list = hit.map((o) => ({ card: o.id, name: o.contact?.name ?? o.name ?? "", stage: stage.get(o.pipelineStageId) ?? o.pipelineStageId, status: o.status, contact_id: o.contact_id, has_remove_tag: !!b.remove_tag && o.tags.some((t) => t.toLowerCase() === b.remove_tag!.toLowerCase()) }));
      const base = { ok: true, dryRun: dry, pipeline: { id: pipe.id, name: pipe.name }, on_board: opps.length, matched: list.length, tag: b.tag, remove_tag: b.remove_tag ?? null };
      if (dry) return NextResponse.json({ ...base, cards: list });
      if (b.expect !== list.length) return NextResponse.json({ error: `found ${list.length} cards, expected ${b.expect}: nothing done (dry run again)` }, { status: 409 });
      await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'ghl.pipeline_cleanup','pipeline',$2,$3,$4)", [co.id, pipe.id, { cards: hit.map((o) => ({ id: o.id, name: o.name, contact_id: o.contact_id, stage: stage.get(o.pipelineStageId), status: o.status, monetaryValue: o.monetaryValue ?? null, tags: o.tags })) }, { why: b.why, tag: b.tag, remove_tag: b.remove_tag ?? null }]);
      const done = { deleted: 0, untagged: 0, failed: [] as string[] };
      for (const o of hit) {
        try { await ghl(ac.pit, "DELETE", `/opportunities/${o.id}`); done.deleted++; } catch (e) { done.failed.push(`${o.id} delete: ${String((e as Error).message).slice(0, 120)}`); continue; }
        if (b.remove_tag && o.contact_id && o.tags.some((t) => t.toLowerCase() === b.remove_tag!.toLowerCase())) {
          try { await ghl(ac.pit, "DELETE", `/contacts/${o.contact_id}/tags`, { body: { tags: [b.remove_tag] } }); done.untagged++; } catch (e) { done.failed.push(`${o.contact_id} untag: ${String((e as Error).message).slice(0, 120)}`); }
        }
      }
      return NextResponse.json({ ...base, ...done });
    });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 500) }, { status: 502 }); }
}
