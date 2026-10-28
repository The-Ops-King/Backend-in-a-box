import { eventsDoor } from "@/api/slack-doors";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** An offer's own Slack app (D174): the events door (D45, D70), handled as in `eventsDoor`. */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  return eventsDoor(req, { companyId: (await params).companyId });
}
