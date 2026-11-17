import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { loadCompany } from "@/engine/context";
import { setBinding } from "@/engine/settings";
import { fathomCreateWebhook } from "@/adapters/fathom/client";
import { WHOP_EVENTS, strayWebhooks, whopCreateWebhook, whopDeleteWebhook, whopGetWebhook, whopListWebhooks, whopUpdateWebhook } from "@/adapters/whop/client";
import { fireNow, workflowWithStep } from "@/engine/clock";
import { registerTypeform } from "@/engine/typeform";
export const dynamic = "force-dynamic";
/** "Click to fix" (D33): make the webhook again, bind the new secret and id, sweep again. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params; const body = await readJson<{ provider?: string }>(req);
  const provider = body?.provider; if (provider !== "whop" && provider !== "fathom" && provider !== "typeform") return fail(400, "provider must be whop, fathom or typeform");
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const { bindings } = await loadCompany(c, co.id);
    try {
      let note: string;
      // D342: a webhook the engine bound that Whop still has is turned on with every event the engine takes, in place (its secret stays, no second webhook)
      const existing = provider === "whop" && bindings["secret.whop_api_key"] && bindings["whop.webhook_id"] && bindings["secret.whop_webhook"] ? await whopGetWebhook(bindings["secret.whop_api_key"], bindings["whop.webhook_id"]) : null;
      if (existing?.ok && existing.found) { const hook = await whopUpdateWebhook(bindings["secret.whop_api_key"], bindings["whop.webhook_id"], [...new Set([...(existing.events ?? []), ...WHOP_EVENTS])]); note = `Whop webhook updated (${hook.id}): on, sending ${hook.events.join(", ")}.`; }
      else if (provider === "whop") { if (!bindings["secret.whop_api_key"]) throw new Error("no Whop API key"); const hook = await whopCreateWebhook(bindings["secret.whop_api_key"], `${base}/api/webhooks/whop/${co.id}`); await setBinding(c, co.id, "secret.whop_webhook", "secret", hook.webhook_secret); await setBinding(c, co.id, "whop.webhook_id", "id", hook.id); note = `Whop webhook re-registered (${hook.id}).`; }
      // D122: the same tag and secret go back on every mapped form (a PUT replaces whatever Typeform holds under the tag)
      else if (provider === "typeform") { const lines = await registerTypeform(co.id, co.slug, bindings, (k, kind, v) => setBinding(c, co.id, k, kind, v)); note = `Typeform: ${lines.join("; ")}.`; }
      else { if (!bindings["secret.fathom_api_key"]) throw new Error("no Fathom API key"); const hook = await fathomCreateWebhook(bindings["secret.fathom_api_key"], `${base}/api/webhooks/fathom/${co.id}`); await setBinding(c, co.id, "secret.fathom_webhook", "secret", hook.secret); await setBinding(c, co.id, "fathom.webhook_id", "id", hook.id); note = `Fathom webhook re-registered (${hook.id}).`; }
      // D343: the webhooks the engine made for this offer that it keeps no secret for (each failed press before D341 left one) are removed
      if (provider === "whop") {
        const now = await loadCompany(c, co.id), key = now.bindings["secret.whop_api_key"];
        const strays = strayWebhooks(await whopListWebhooks(key), `${base}/api/webhooks/whop/${co.id}`, now.bindings["whop.webhook_id"]);
        for (const h of strays) await whopDeleteWebhook(key, h.id);
        if (strays.length) note += ` Removed ${strays.length} extra webhook${strays.length === 1 ? "" : "s"} (${strays.map((h) => h.id).join(", ")}).`;
      }
      await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'webhook.reregistered','company',$2,$3)", [co.id, co.id, { provider, note }]);   // D341: $1 was both company_id (uuid) and target_id (text)
      const wf = await workflowWithStep(c, co.id, "health_check");
      if (wf?.enabled) { const r = await fireNow(c, co.id, wf.id); if (r.started.length) note += " Sweeping again now."; }
      return ok({ ok: true, note });
    } catch (e) { return fail(502, `Could not re-register the ${provider} webhook: ${String((e as Error).message).slice(0, 160)}`); }
  });
}
