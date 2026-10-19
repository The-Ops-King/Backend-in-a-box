import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok } from "@/api/http";
import { filtersState } from "@/onboarding/filters";
export const dynamic = "force-dynamic";

/** D180: their own GHL workflows as last read, each one's mark, what is left, and whether a fresh check is in hand for the next move up. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const s = await filtersState(c, co.id);
    return s ? ok(s) : fail(404, "this company is not being onboarded");
  });
}
