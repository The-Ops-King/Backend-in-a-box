import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok } from "@/api/http";
import { testsState } from "@/onboarding/tests";
export const dynamic = "force-dynamic";

/** D157: the test passes: the scenarios this offer has, each one's latest result, each workflow's state, the test contacts to choose from, what is left. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const s = await testsState(c, co.id);
    return s ? ok(s) : fail(404, "this company is not being onboarded");
  });
}
