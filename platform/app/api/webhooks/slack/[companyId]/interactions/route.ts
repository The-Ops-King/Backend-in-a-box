import { interactionsDoor } from "@/api/slack-doors";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** An offer's own Slack app (D174): the interactivity door (D93, D200, D202), handled as in `interactionsDoor`. */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  return interactionsDoor(req, { companyId: (await params).companyId });
}
