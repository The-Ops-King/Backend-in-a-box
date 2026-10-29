import { commandsDoor } from "@/api/slack-doors";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** An offer's own Slack app (D174): the slash commands door (D70), handled as in `commandsDoor`. */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  return commandsDoor(req, { companyId: (await params).companyId });
}
