# Whop webhooks — verified facts (2026-10-06, from docs.whop.com)

| Fact | Detail |
|---|---|
| Spec | Standard Webhooks. Headers `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature` (`v1,<base64>`; several space-separated during key rotation), `content-type`. These four never change across API versions. |
| Signature | HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, key = the `ws_…` signing secret as given. Verify with a constant-time compare; reject timestamps older than five minutes. The secret is shown once at webhook creation (`webhook_secret`). |
| Envelope (api_version v1) | `{ id: "msg_…", type: "payment.succeeded", api_version: "v1", api_version_date, timestamp, account_id (company_id on pins before 2026-08-14), data: <Payment> }`. Legacy v2/v5 envelopes exist for old integrations and do not use these signatures: create the webhook on v1. |
| Payment data | `id` (pay_…), `status` (e.g. `paid`), `substatus`, `total: { amount: "29.99", currency: "usd" }` (strings), `subtotal`, `currency`, `customer_email`, `customer_phone`, `member_id` (mber_…, the stable buyer id), `membership_id`, `plan_id`, `product_id`, `paid_at` (ISO), `created_at`, `billing_reason`, `payment_method_type`, `refunded_amount`, `metadata`, `failure_message`, `decline_code`, `payments_failed`, `recovery_url`, `line_items[]`. No GHL id anywhere unless checkout metadata carries one. |
| Events we record | `payment.succeeded` → ledger row, `payment.failed` → failed row (amount from `total`), `refund.created` → negative row keyed by the refund id (`data.payment_id` in raw). Others ignored with 200. |
| Delivery | At-least-once; same `webhook-id` on every retry of a delivery (we store it in `webhook_deliveries` before parsing). Retries for ~3 days. Must answer 2xx within 5 seconds. Order not guaranteed. |
| Our endpoint | `POST /api/webhooks/whop/<companyId>`; secret bound per company as `secret.whop_webhook` (install `whop: { webhookSecret }`). |
