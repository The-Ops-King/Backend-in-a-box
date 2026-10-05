# Software stack and cost

Prices checked Sep 2026. All monthly-billing unless noted; annual saves 15–20% on most.

---

## Your side — fixed, regardless of client count

| Tool | Plan | Monthly | Annual/mo | Why this tier |
|---|---|---|---|---|
| GoHighLevel | Unlimited | $297 | $248 | Unlimited sub-accounts. Starter's 3 caps you at 3 clients. |
| Zapier | Team | $103.50 | $69 | Shared connections across clients + 25 users. Professional is single-user and breaks at multi-client. |
| Fathom | Team, 2 seats | $38 | $30 | Min 2 seats |
| Slack | Free | $0 | $0 | See `08-slack.md` — channels replace paid user groups |
| **Total** | | **~$439** | **~$347** | |

### The GHL tier decision is an offer decision, not an IT decision

- **Unlimited $297** — clients live as sub-accounts under you. You hold the keys. Simple.
- **Agency Pro $497** — adds SaaS mode: rebill GHL to clients at your own price, with
  markup, billed through your Stripe.

The $200 delta buys the ability to turn GHL from a cost into a margin line. If you charge
$297/mo for "their CRM" and pay $497 once across all clients, that flips profitable at
client two and compounds from there.

**Decide this before you write the offer.** It changes whether software is a cost you
absorb, a cost they carry, or a revenue line you own.

---

## Client side — per client, per month

Assuming a typical install: owner + 1 closer + 1 setter.

| Tool | Plan | Cost | Notes |
|---|---|---|---|
| GHL sub-account | — | $0 or rebilled | Zero marginal cost to you on Unlimited |
| GHL usage | SMS, email, AI | $20–150 | Volume-dependent. Budget $50. |
| Typeform | Plus | $79 | **Challenge this — see below** |
| Fathom | per closer | $19/user | $38 for owner + closer |
| Aloware | iPro + AI | $30/user | $60 for setter + closer, plus per-minute |
| Whop | transaction | 2.7% + $0.30 | No platform fee as of Aug 2026 |
| **Running total** | | **~$227/mo** | plus Whop % and call minutes |

---

## Kill Typeform

$79/month per client, forever, for qualification questions.

The two-step intake exists because the spec wanted Typeform out of the critical path —
"if that integration fails you lose qualification answers, not the lead." Sound reasoning
when the alternative was a fragile direct-to-object write.

That reasoning no longer holds:

1. GHL forms do conditional logic natively.
2. Forms are **API-generatable** — create with full `formData`, verified persisting and
   serving. A niche config can generate the qualification form per client automatically.
3. Every niche's questions differ. Generating them from config beats hand-building a
   Typeform per client either way.

Dropping it removes **$79/mo/client**, one integration, one failure point, one place the
contact ID has to survive a redirect, and the open "can Typeform carry the contact ID as a
hidden field" question that was never answered.

Client cost drops from ~$227 to ~$148/month.

**Caveat, stated plainly:** Typeform converts better than a plain form. That is real and
worth money on a high-ticket application. Test it before you rip it out — but do not
carry it into every snapshot by default for a reason that expired.

---

## Costs nobody has counted yet

| Item | Status |
|---|---|
| LLM calls — outcome inference, notes generation, semantic matching | Per-call, tiny, but not $0. Meter it. |
| A2P registration | One-time, plus per-campaign |
| GHL Math Operation action | **May be premium-billed per execution.** Every payment event fires one. Unverified. |
| GHL Custom Webhook action | Same question, unverified. Every Slack alert fires one. |
| The dashboard | Hosting, whatever you build it on |

Those two GHL questions are the only ones that could move per-client cost meaningfully,
because they fire on every single event rather than monthly. Verify before pricing.

---

## Sources

[GHL pricing](https://www.ghlexperts.com/gohighlevel-plans-pricing) ·
[Zapier pricing](https://www.nocode.mba/articles/zapier-pricing-2026) ·
[Fathom pricing](https://www.layer3labs.io/guides/fathom-pricing) ·
[Typeform pricing](https://www.typeform.com/pricing) ·
[Aloware pricing](https://aloware.com/pricing) ·
[Whop fees](https://docs.whop.com/fees) ·
[Slack pricing](https://slack.com/pricing)
