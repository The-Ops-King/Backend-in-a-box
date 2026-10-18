import { asOperator } from "@/db/client";
import { companiesPage } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { createClient } from "@/onboarding/store";
export const dynamic = "force-dynamic";
export async function GET() { return ok(await asOperator((c) => companiesPage(c))); }
/** D143: Add client. { name, slug?, timezone, kind: new | takeover } → the company, in ghost and onboarding (nothing runs yet), and its wizard. */
export async function POST(req: Request) {
  const body = await readJson<{ name?: unknown; slug?: unknown; timezone?: unknown; kind?: unknown }>(req);
  if (!body) return fail(400, "a JSON body is required");
  const r = await asOperator((c) => createClient(c, { ...body, by: "dashboard" }));
  return r.ok ? ok({ ok: true, id: r.id, slug: r.slug, href: `/app/c/${r.slug}/onboarding` }, { status: 201 }) : fail(r.status, r.why);
}
