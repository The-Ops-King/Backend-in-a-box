import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { liveAdapters } from "@/adapters";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

type Ask = { company?: string; contact?: string; delete?: string; why?: string; dryRun?: boolean };
/** The contact's GHL id, by its GHL id or ours. */
async function ghlOf(c: import("pg").PoolClient, slug: string, contact: string) {
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return { error: "no such company", status: 404 } as const;
  const ct = await one<{ id: string; g: string | null; name: string }>(c, "select id, ghl_contact_id as g, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as name from contacts where company_id=$1 and (id::text=$2 or ghl_contact_id=$2)", [co.id, contact]);
  if (!ct?.g) return { error: "no such contact, or it has no CRM id", status: 404 } as const;
  return { co: co.id, ct } as const;
}

/**
 * D257: one contact's notes in GHL. GET ?company=&contact= lists them (id, when, first line). POST { company, contact, delete: <note id>,
 * why, dryRun = true } removes one (a call summary written twice). Audited. Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), contact = q.get("contact");
  if (!slug || !contact) return NextResponse.json({ error: "company and contact are required" }, { status: 400 });
  return asOperator(async (c) => {
    const w = await ghlOf(c, slug, contact); if ("error" in w) return NextResponse.json({ error: w.error }, { status: w.status });
    if (!liveAdapters.read.contactNotes) return NextResponse.json({ error: "this CRM cannot list notes" }, { status: 400 });
    const { adapterCompany } = await loadCompany(c, w.co);
    const notes = (await liveAdapters.read.contactNotes(adapterCompany, w.ct.g!)).map((n) => ({ id: n.id, at: n.dateAdded, first_line: n.body.split("\n")[0].slice(0, 120), length: n.body.length }));
    return NextResponse.json({ ok: true, contact: { id: w.ct.id, name: w.ct.name }, notes });
  });
}

export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Ask | null;
  if (!b?.company || !b.contact || !b.delete || !b.why?.trim()) return NextResponse.json({ error: "company, contact, delete (a note id) and why are required" }, { status: 400 });
  return asOperator(async (c) => {
    const w = await ghlOf(c, b.company!, b.contact!); if ("error" in w) return NextResponse.json({ error: w.error }, { status: w.status });
    if (!liveAdapters.read.contactNotes || !liveAdapters.write.deleteNote) return NextResponse.json({ error: "this CRM cannot list or delete notes" }, { status: 400 });
    const { adapterCompany } = await loadCompany(c, w.co);
    const note = (await liveAdapters.read.contactNotes(adapterCompany, w.ct.g!)).find((n) => n.id === b.delete);
    if (!note) return NextResponse.json({ error: "that note is not on this contact" }, { status: 404 });
    const said = { id: note.id, at: note.dateAdded, first_line: note.body.split("\n")[0].slice(0, 120) };
    if (b.dryRun !== false) return NextResponse.json({ ok: true, dryRun: true, would_delete: said });
    await liveAdapters.write.deleteNote(adapterCompany, w.ct.g!, note.id);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'contact.note_deleted','contact',$2,$3,$4)", [w.co, w.ct.id, said, { why: b.why }]);
    return NextResponse.json({ ok: true, dryRun: false, deleted: said });
  });
}
