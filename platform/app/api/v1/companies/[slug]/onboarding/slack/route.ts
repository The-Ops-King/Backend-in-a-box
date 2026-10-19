import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok } from "@/api/http";
import { slackState } from "@/onboarding/slack";
export const dynamic = "force-dynamic";

/** D174: the Slack step: the manifest, whether the bot is connected, each channel slot, and the channels the bot can see. Never a token. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const s = await slackState(c, co.id);
    return s ? ok(s) : fail(404, "this company is not being onboarded");
  });
}
