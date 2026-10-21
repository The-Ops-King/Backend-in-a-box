import { defaultSlackApp } from "@/slack/default";
import { slackDoor } from "@/slack/http";

export const dynamic = "force-dynamic";

/** POST /slack/events: signed by Slack, kept once, answered at once; the work is a job (src/slack/http.ts). */
export async function POST(req: Request) {
  return slackDoor(defaultSlackApp(), "events", req);
}
