import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { slackPage } from "@/api/slack-steps";
import { fail, ok } from "@/api/http";
export const dynamic = "force-dynamic";
/** Every Slack step of the company's workflows, where each posts today, and the company's own channels to pick from. */
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => { const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company"); return ok(await slackPage(c, co.id)); });
}
