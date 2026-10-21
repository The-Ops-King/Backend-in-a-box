import { slackEnv } from "@/slack/env";
import { installRedirect } from "@/slack/oauth";

export const dynamic = "force-dynamic";

/** GET /slack/install?offer=<signed state>: the Connect Slack link, on to Slack's "Add to Slack" page. */
export async function GET(req: Request) {
  return installRedirect(slackEnv(), new URL(req.url), new Date());
}
