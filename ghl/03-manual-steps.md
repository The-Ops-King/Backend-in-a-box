# What the API cannot build

Everything here is a hand step. It is the real install time, and it does not compress.

## Per build (once, then it travels in the snapshot)

### Workflows — all 11, UI only

`POST /workflows/` returns 404. There is no create endpoint. Each of these is built by
hand once and then travels:

`[CORE] Stamp Attribution` · `[CORE] Create Opportunity` · `[CORE] Speed to Lead` ·
`[CORE] Same-Day Coverage` · `[CORE] Log First Call` · `[CORE] Mirror State Tags` ·
`[CORE] Pre-Call Reminders` · `[CORE] Ask For Disposition` · `[CORE] No-Show Rebooking` ·
`[CORE] Cancelled Call` · `[CORE] Close Check`

Plus the `[STANDARD]` extension points, which ship empty: Deal Closed, Deal Lost,
Call Booked, No Show, Lead Created.

**All built OFF.**

### Calendar settings the API does not expose

On **Closer Call (Self Book)**, set by hand:

| Setting | Value | Why |
|---|---|---|
| Allow Staff Selection | OFF | Letting the prospect pick scrambles setter credit |
| Reschedule preference | Keep Same Appointment Owner | Otherwise a reschedule silently moves the call to another closer and attribution breaks |
| Form position | First in widget order | Assigned-user matching cannot run otherwise |

`Always Book with Assigned User` **is** set via API (`shouldAssignContactToTeamMember`)
and is already on.

### Forms

Intake (step 1), Lead Magnet Optin, and Disposition. The disposition form is conditional
and must never show more than four fields at once.

### Smart lists

Not listed among snapshot asset types in GHL's documentation. Assume they do not travel
until proven otherwise — if they don't, all eight become an install step.

## Per install (every client, every time)

Snapshots do not carry users, and carry calendars in a half-connected state.

1. Create the client's users — snapshots never include them
2. Reassign each calendar's team member — the assignment does not survive deployment
3. Reconnect Google or Outlook per sub-account — connections do not travel
4. Set the sub-account timezone and business hours
5. Create the Slack workspace, three groups, and the incoming webhook
6. Paste the webhook URL into Custom Values *before* enabling any alerting workflow
7. **Wire Whop, per client, in this order** — see below
8. Turn workflows on — last, only after migration completes
9. Deselect or delete leftover template artifacts (see `00-state.md` → Known residue)

### Whop wiring — order is not optional

The three payment workflows trigger on Whop webhooks. GHL generates each workflow's
inbound webhook URL **when the workflow is created, scoped to that sub-account**. The
workflow travels in the snapshot; its webhook URL does not — the deployed copy gets a new
URL in the client's location.

So Whop can never be configured ahead of time, and the template's URLs are worthless to a
client. Every install repeats this:

1. Open `[CORE] Payment Received` in the client's sub-account, copy its inbound webhook URL
2. Paste it into that client's Whop as the payment-succeeded endpoint
3. Repeat for `[CORE] Payment Failed` → payment-failed
4. Repeat for `[CORE] Payment Cancelled` → membership-cancelled
5. Fire one test event per endpoint before turning the workflows on

Skipping step 5 means the first real payment is the test, and a missed
payment-succeeded webhook means `client_since` and `first_payment_at` never stamp — which
silently breaks `[CORE] Close Check` and leaves a paid client sitting in Closed Won limbo.

## Blocked, not deferred

**A2P / SMS.** Six SMS sends exist in this build: three pre-call reminders, no-show,
cancel, disposition ask. Without a registered number none of them can be sent even once.
Registration needs a live privacy policy and terms page on a real domain.

Consequence, stated plainly: the snapshot will ship with six SMS steps that have never
been fired in anger. They are built, they are unverified, and the first real test will be
on a client's contacts.
