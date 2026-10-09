import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { loadCompany } from "@/engine/context";
import { setBinding } from "@/engine/settings";
import { fathomCreateWebhook } from "@/adapters/fathom/client";
import { whopCreateWebhook } from "@/adapters/whop/client";
import { fireNow, workflowWithStep } from "@/engine/clock";
export const dynamic = "force-dynamic";
/** "Click to fix" (D33): make the webhook again, bind the new secret and id, sweep again. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const body = await readJson<{ provider?: string }>(req);
  const provider = body?.provider; if (provider !== "whop" && provider !== "fathom") return fail(400, "provider must be whop or fathom");
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const { bindings } = await loadCompany(c, co.id);
    try {
      let note: string;
      if (provider === "whop") { if (!bindings["secret.whop_api_key"]) throw new Error("no Whop API key"); const hook = await whopCreateWebhook(bindings["secret.whop_api_key"], `${base}/api/webhooks/whop/${co.id}`); await setBinding(c, co.id, "secret.whop_webhook", "secret", hook.webhook_secret); await setBinding(c, co.id, "whop.webhook_id", "id", hook.id); note = `Whop webhook re-registered (${hook.id}).`; }
      else { if (!bindings["secret.fathom_api_key"]) throw new Error("no Fathom API key"); const hook = await fathomCreateWebhook(bindings["secret.fathom_api_key"], `${base}/api/webhooks/fathom/${co.id}`); await setBinding(c, co.id, "secret.fathom_webhook", "secret", hook.secret); await setBinding(c, co.id, "fathom.webhook_id", "id", hook.id); note = `Fathom webhook re-registered (${hook.id}).`; }
      await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'webhook.reregistered','company',$1,$2)", [co.id, { provider, note }]);
      const wf = await workflowWithStep(c, co.id, "health_check");
      if (wf?.enabled) { const r = await fireNow(c, co.id, wf.id); if (r.started.length) note += " Sweeping again now."; }
      return ok({ ok: true, note });
    } catch (e) { return fail(502, `Could not re-register the ${provider} webhook: ${String((e as Error).message).slice(0, 160)}`); }
  });
}
