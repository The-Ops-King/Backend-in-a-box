import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok } from "@/api/http";
import { listMessages } from "@/onboarding/messages";
export const dynamic = "force-dynamic";

/** D177: every text and email this client's contacts can get, its words, whether it is a placeholder or carries another client's words, and whether it is approved. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    return ok(await listMessages(c, co.id));
  });
}
