import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { editMessage, listMessages } from "@/onboarding/messages";
export const dynamic = "force-dynamic";

/** D155: a company's texts and emails and their words (a template business's above all), for editing outside the onboarding wizard. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => { const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company"); return ok(await listMessages(c, co.id)); });
}
/** { workflowId, nodeId, field, text } → the words changed, kept as the company's own (D154). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = await readJson<{ workflowId?: unknown; nodeId?: unknown; field?: unknown; text?: unknown }>(req);
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const r = await editMessage(c, co.id, { ...(b ?? {}), by: "dashboard" });
    return r.ok ? ok({ ok: true }) : fail(r.status, r.why);
  });
}
