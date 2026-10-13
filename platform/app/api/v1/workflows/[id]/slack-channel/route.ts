import { asOperator } from "@/db/client";
import { setStepChannel, workflowSlack } from "@/api/slack-steps";
import { fail, ok, readJson } from "@/api/http";
export const dynamic = "force-dynamic";
/** GET → this workflow's Slack steps, where each posts today, and the company's own channels to pick from. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asOperator(async (c) => { const r = await workflowSlack(c, id); return r ? ok(r) : fail(404, "no such workflow"); });
}
/** POST { node, channel } → this Slack step posts to `channel` (a channel id from the company's workspace, or "default" for the company setting). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ node?: string; channel?: string }>(req);
  if (!body?.node || !body.channel) return fail(400, "node and channel are required");
  return asOperator(async (c) => { const r = await setStepChannel(c, { workflowId: id, nodeId: body.node!, channel: body.channel! }); return r.ok ? ok(r) : fail(r.status, r.why); });
}
