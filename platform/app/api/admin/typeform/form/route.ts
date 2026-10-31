import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { loadCompany } from "@/engine/context";
import { liveTypeform, type TfField } from "@/adapters/typeform/client";
import { formsOf, TF_TOKEN_KEY } from "@/engine/typeform";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D282: GET ?company=<slug>&form=<Typeform form id>: the form's questions (ref, type, title, choices) and hidden fields, through the
 * offer's own Typeform token, and the offer's map for it if it has one: what a form map (typeform.forms) is written from; and where a
 * finished form sends the person (each ending's redirect, the form's own, the logic jumps to an ending). Read only.
 * Authorization: Bearer $CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams, slug = q.get("company"), form = q.get("form");
  if (!slug || !form || !/^[A-Za-z0-9]+$/.test(form)) return NextResponse.json({ error: "company and form are required" }, { status: 400 });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]); if (!co) return NextResponse.json({ error: "no such company" }, { status: 404 });
    const { bindings } = await loadCompany(c, co.id);
    const token = bindings[TF_TOKEN_KEY]; if (!token) return NextResponse.json({ error: `no Typeform token bound (${TF_TOKEN_KEY})` }, { status: 400 });
    try {
      const f = await liveTypeform.getForm(token, form);
      const flat = (xs: TfField[]): TfField[] => xs.flatMap((x) => [x, ...flat(x.properties?.fields ?? [])]);
      const questions = flat(f.fields ?? []).filter((x) => x.type !== "group" && x.type !== "statement").map((x) => ({ ref: x.ref, type: x.type, title: x.title, ...(x.properties?.choices?.length ? { choices: x.properties.choices.map((ch) => ch.label) } : {}) }));
      // where a finished form sends the person: each ending's redirect, the form-wide one, and the logic that picks an ending
      const raw = f as unknown as { thankyou_screens?: { ref: string; title?: string; properties?: { redirect_url?: string } }[]; settings?: { redirect_after_submit_url?: string };
        logic?: { ref: string; actions?: { action: string; details?: { to?: { type?: string; value?: string } } }[] }[] };
      const endings = (raw.thankyou_screens ?? []).map((t) => ({ ref: t.ref, title: t.title ?? "", redirect: t.properties?.redirect_url ?? null }));
      const toEndings = (raw.logic ?? []).flatMap((l) => (l.actions ?? []).filter((a) => a.action === "jump" && a.details?.to?.type === "thankyou").map((a) => ({ from: l.ref, to: a.details!.to!.value })));
      return NextResponse.json({ ok: true, id: f.id, title: f.title, questions, hidden: f.hidden ?? [], map: formsOf(bindings)[form] ?? null, endings, redirect_after_submit: raw.settings?.redirect_after_submit_url ?? null, jumps_to_endings: toEndings });
    } catch (e) { return NextResponse.json({ error: String((e as Error).message).slice(0, 300) }, { status: 502 }); }
  });
}
