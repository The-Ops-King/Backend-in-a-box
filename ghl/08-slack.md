# Slack architecture

## The spec's assumption is wrong

> "Workspace, plus three user groups: `@setters`, `@closers`, `@leadership`. Free tier is enough."

**User groups are a paid feature.** `@subteam` mentions require Slack Pro, $7.25/user/month.
On the free plan you cannot create `@setters` at all.

That matters because the whole notification design rests on it:

> "Every alert targets a group, never a person. Hiring is a membership change, never a
> workflow edit."

## The fix — channels are the groups

Don't pay for Pro. Use one channel per role and target `@channel`.

A channel has exactly the property the design needs: membership is editable without
touching a workflow, and the alert addresses a role rather than a person. Hiring a setter
means adding them to `#setters`. Same guarantee, zero cost.

| Channel | Receives | Visibility |
|---|---|---|
| `#setters` | Speed to lead + escalations, same-day coverage, no-shows to rebook, cancelled-needs-rebook, DQ pings | Public |
| `#closers` | Disposition asks, EOD open dispositions, follow-ups due, deposits open | Public |
| `#leadership` | Speed-to-lead final escalation, payment failed, payment cancelled, hygiene queue, no-attribution | **Private** |
| `#wins` | Closed Won only | Public |

Four channels. For a solo operator all four contain only them — which is correct, and
matches the spec's own "all three groups contain the owner."

**Why `#wins` is separate.** Wins buried in an ops firehose stop being wins. It is also
the only channel anyone opens voluntarily, which is what makes the rest of the system get
read at all.

**Why `#leadership` is private.** Payment failures name clients and dollar amounts. A
setter has no reason to see that. Private channels work on the free plan.

## Custom values

One webhook per channel. Four slots, not one:

`slack_webhook_setters` · `slack_webhook_closers` · `slack_webhook_leadership` ·
`slack_webhook_wins`

This replaces the single `slack_webhook_url` currently built. Targeting a role becomes
choosing a webhook, which means no `@subteam` syntax anywhere and nothing to rewrite if a
client later upgrades to Pro.

## Free plan constraints that actually bite

| Limit | Consequence |
|---|---|
| 90-day message history | Slack is the notification layer, never the record. Anything that must survive lives in GHL or the dashboard. |
| 10 app integrations | Incoming webhooks are not apps, so four webhooks cost one slot. Fine. |
| Slack Connect 1:1 only | Cannot share a channel with the client's workspace on free. Matters if you want a shared channel per client. |

That last one is the only real upgrade trigger. If the delivery model includes a shared
channel between your workspace and each client's, that is Pro on **your** side.

## Unfurl

Every webhook payload carrying an action link sets `unfurl_links: false` and
`unfurl_media: false`. See the disposition flow — Slack fetches URLs to build previews,
and a preview fetch on a state-changing link fires the state change.
