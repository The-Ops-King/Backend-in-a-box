# Payment layer

Applied Sep 12. The Clients pipeline is cancelled — payment health is a state, not a
position. The Closed Won deal is the only record of the sale.

## Contact fields

| Field | Type | Built |
|---|---|---|
| `* payment_status` | Dropdown — paid_in_full, active, failed, cancelled | ✅ updated |
| `* total_collected` | Monetary | ✅ |
| `* last_payment_date` | Date | ✅ |
| `* failed_payment_count` | Number, never decremented | ✅ new |
| `* whop_membership_id` | Text, match key | ✅ |
| `* client_since` | Date, stamped on first payment | ✅ new |

`failed` and `cancelled` stay separate on purpose. A failed card is money still coming;
a cancelled plan is money that is not. Merged, collected-percent becomes unreadable —
60% and climbing looks identical to 60% and final.

`recovered` is dropped. A recovered payment returns to `active`. History lives in
`failed_payment_count`.

## Two problems with the workflows as specified

### `[CORE] Payment Received` step 4 cannot be built as written

> `total_collected` ≥ `contract_value` → `payment_status = paid_in_full`

`total_collected` is a **contact** field. `contract_value` is a **Sales Call object**
field. Verified — there is no `contract_value` on the contact. A GHL contact workflow
cannot read a field on an associated object record, so this comparison has nothing to
compare against.

Three ways out:

1. **Stamp `contract_value` onto the contact** at disposition, alongside the Sales Call
   record. One more contact field, written once per won deal. Simplest, and it keeps the
   object as the historical record while the contact carries current state — which is
   already the pattern everywhere else in this build.
2. Run the comparison as an object workflow on Sales Call. Inverts the design: the object
   would have to read contact state instead.
3. Let the dashboard compute `paid_in_full` and never store it. Consistent with "GHL
   stores, the dashboard computes" — but then no smart list can filter on it, and no
   workflow can branch on it.

**Recommend option 1.** It matches the existing split and costs one field.

### Both increments depend on an unverified action

> "add amount to `total_collected`" and "increment `failed_payment_count`"

These need arithmetic inside a workflow. GHL's Math Operation action exists, but two
things are unconfirmed: whether it is available on this plan, and whether it is billed as
a premium action per execution. Every payment event fires one, so premium billing is a
real per-client cost, not a rounding error.

**Verify before the payment workflows get built.** If Math Operation is unavailable, both
counters have to be computed externally and written back, which changes all three workflows.

## Whop — sequencing

All three workflows trigger on Whop webhooks. GHL generates the inbound webhook URL *per
workflow*, when the workflow is created. So Whop cannot be configured until the workflows
exist. Order: build workflow → copy its URL → configure Whop → test.

Whop is not connected to anything yet.

## Extension points — now 7

Deal Closed · Deal Lost · Call Booked · No Show · Lead Created · **Payment Failed** ·
**Payment Cancelled**

`Client Onboarded` dropped with the Clients pipeline.

## Smart lists — now 10

Two added: **Behind on payment** (`payment_status = failed`) and **Cancelled plans**
(`payment_status = cancelled`, `client_since` this quarter). Both leadership-facing.

## Dashboard metrics

| Metric | Source |
|---|---|
| Payment status per client | `payment_status` |
| Total contracted | Sum of `contract_value` on won Sales Call records |
| Total collected | Sum of `total_collected` |
| Collected percent | collected ÷ contracted |
| Outstanding | contracted − collected, **excluding `cancelled`** |

The exclusion is the entire reason `cancelled` is its own value. Outstanding that includes
dead plans is a number nobody can act on.

## Settled

`total_collected` stays **Monetary** — confirmed Sep 12. All three money fields
(`total_collected`, `cash_collected`, `contract_value`) are Monetary. No mixed typing.
