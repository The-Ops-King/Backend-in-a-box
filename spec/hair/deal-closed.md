# Deal closed

Offer: **Save Your Hair (Parungao)** (`hair`). Source: live database. Generated 2026-10-21.

| Setting | Value |
| --- | --- |
| Where this definition came from | live: version 6, saved 2026-10-19T16:47:56.903Z (D119 deposit: a deposit is its own kind (card to Deposit, never a win or a welcome, no chase) (Tyler: the deposit option)) |
| Template | `deal-closed` v7 |
| Edited since copied from the template | no |
| Saved version | 6 |
| Enabled | on |
| Mode | follows the offer (test) |
| Send lock | locked: texts, emails, documents and webhooks reach only the operator's own addresses |
| Runs again for the same person | once_per_contact |
| Re-checked before every step | contact exists |
| Send window | 08:00 to 20:00, the contact's time zone; transactional messages may go at any hour |
| Steps | 13 |

## Steps

Every step, in the order a run meets it from the trigger. Steps that only assemble words (`set_var`) are listed too.

### 1. Payment received

- Step id `t1`, type `trigger`

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t1",
  "type": "trigger",
  "event": "payment.received"
}
```

</details>

### 2. Agreement signed

- Step id `t2`, type `trigger`

Next:
- always → step 3 (`c1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "t2",
  "type": "trigger",
  "event": "agreement.signed"
}
```

</details>

### 3. Paid beyond a deposit and signed, and not a customer yet (D119: a deposit alone, even signed, is not a close)

- Step id `c1`, type `check`
- Engine description: Check contact paid non deposit and they have signed the agreement and tags do not include “stat customer”
- Detail: Otherwise the run stops: not yet
- If it keeps failing: the run is held on this step (it decides whether the run goes on)

Next:
- always → step 4 (`g1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "c1",
  "title": "Paid beyond a deposit and signed, and not a customer yet (D119: a deposit alone, even signed, is not a close)",
  "type": "check",
  "when": {
    "and": [
      {
        "eq": [
          "{{contact.paid_non_deposit}}",
          true
        ]
      },
      {
        "eq": [
          "{{contact.agreement_signed}}",
          true
        ]
      },
      {
        "not": {
          "has": [
            "{{contact.tags}}",
            "stat-customer"
          ]
        }
      }
    ]
  },
  "else_exit": "not_yet"
}
```

</details>

### 4. Add tag “stat-customer”

- Step id `g1`, type `set_tag`
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 5 (`p1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "g1",
  "type": "set_tag",
  "tag": [
    "stat-customer"
  ]
}
```

</details>

### 5. Create or move pipeline card

- Step id `p1`, type `pipeline_card`
- Detail: In the closer board, stage Closed Won; marked won
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 6 (`p2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p1",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_closer}}",
  "stage": "{{crm.stage_closer_closed_won}}",
  "status": "won",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 6. Update the setter card

- Step id `p2`, type `pipeline_card`
- Detail: Card stays where it is; marked won
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 7 (`b1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "p2",
  "type": "pipeline_card",
  "pipeline": "{{crm.pipeline_setter}}",
  "status": "won",
  "if_missing": "create",
  "pick": "open",
  "fields": []
}
```

</details>

### 7. Which way?

- Step id `b1`, type `branch`
- If it keeps failing: the run is held on this step (it decides where the run goes)

Next:
- has a Sales Call record (when there is a their Sales Call record) → step 8 (`r1`)
- no Sales Call record → step 9 (`e1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "b1",
  "type": "branch"
}
```

</details>

### 8. Update sales call record

- Step id `r1`, type `crm_record`
- Detail: Keyed by their Sales Call record; 3 fields; only if the record already exists
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Next:
- always → step 9 (`e1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "r1",
  "type": "crm_record",
  "object": "{{crm.object_sales_call | default:custom_objects.sales_call}}",
  "key": "{{records.sales_call.key}}",
  "properties": {
    "outcome": "{{picklist.sales_call_outcome.showed}}",
    "disposition": "closed_won",
    "cash_collected": "{{contact.cash_collected}}"
  },
  "if_missing": "skip",
  "relate": [],
  "clear": []
}
```

</details>

### 9. Send email: “Welcome — Let's Get You Ready for Your First Coaching Call”

- Step id `e1`, type `send_email`
- Detail: Automated receipt: may go out in dark hours if the company allows it
- Goes to: the contact's email (transactional)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Email subject:

```
Welcome — Let's Get You Ready for Your First Coaching Call
```

Email body:

```
<p>Hi {{contact.first_name}},</p><p>Welcome, and congratulations on taking action early. Catching hair changes in their earliest stages is one of the biggest advantages you can give yourself, and I'm glad to be your coach through this.</p><p>First, an important note about what this is (and isn't)</p><p>I want to be completely clear from the start: this is a lifestyle and wellness coaching relationship. I am your coach, not your doctor. Our work together does not create a doctor-patient relationship, I do not diagnose medical conditions, and I do not prescribe or manage medications. My role is to guide you toward the habits, nutrition, stress management, and tracking practices that support the healthiest possible hair — and to help you become an informed, organized partner in your own care.</p><p>As a coach, I am not able to prescribe medications. However, as we have discussed, your enrollment includes a $2,000 program credit that can be applied toward the cost of any treatments you may ultimately need. Whether any such treatments are appropriate for you is a decision made between you and a licensed clinician. During our first one-on-one coaching session, we will review your goals and circumstances together that are customized to you and your specific stage. From here I will help guide you toward reputable resources—including over-the-counter options and licensed telehealth providers—so you can obtain exactly what you need from the appropriate source.</p><p>Here are your next steps before our first call coming up...</p><p>To make our first session as productive as possible, please complete as many of the following as you can:</p><p>1. Complete your intake questionnaire. This is the single most important step — it tells me about your history, lifestyle, and goals so we don't spend our call gathering basics. https://saveyourhairtoday.com/in-take</p><p>2. Take your baseline "before" photos. Use consistent lighting (same spot, same time of day), the same distance, and capture four views: front/hairline, top/crown looking down, and both sides. Keep the same phone and angle each time so future photos are truly comparable. We'll use these to track progress objectively over the months ahead. Take those photos and send directly to me via telegram at the telegram account below</p><p>3. Make a list of everything you currently take. Include all prescription medications, over-the-counter products, vitamins, and supplements — with doses. Some common medications and supplements can affect hair, and your clinician will want an accurate list too. Send that to me in our 1-on-1 thread in the telegram below</p><p>4. Note any recent major life events or health changes in the last 6–12 months — significant stress, illness, rapid weight change, dietary changes, or new medications. These often matter for the timeline of hair changes. Send that to me in our 1-on-1 thread in the telegram below</p><p>5. Do a quick honest audit of four lifestyle anchors: sleep (hours and quality), nutrition (especially protein and overall diet quality), stress level, and smoking/alcohol use. Just jot down where you honestly stand — no judgment, this is our starting point. Send that to me in our 1-on-1 thread in the telegram below</p><p>6. Think about your goals and your "why." What does success look like to you in 6 and 12 months? Being specific helps us set realistic, honest expectations together. Send that to me in our 1-on-1 thread in the telegram below</p><p>7. Set aside a private, quiet 45–60 minutes for our first call, with your photos and lists in front of you. Book your call here https://calendly.com/allan-saveyourhairtoday</p><p>A word on expectations</p><p>Hair responds slowly. Meaningful changes from lifestyle work and any medical treatments can take time. Our goal is by weeks 2 to 4, you'll see less hair coming out in the shower. This is the first sign the protocol is active. By month 6, most clients see 30 to 50% less scalp visibility in their progress photos. By weeks 12 to 24, existing follicles that were thinning start producing visibly thicker hair. So your consistency matters far more than intensity. We'll set clear, realistic milestones together on our first call so you always know what "on track" looks like.</p><p>If you have any questions before we talk, just reply to this email or text me in our telegram thread</p><p>Looking forward to getting started,</p><p>Dr. Allan Parungao</p><p>-The Hair Surgeon's Scorecard</p><p>Telegram: @DrEastside</p><p>This message is for general wellness and educational coaching purposes only. It is not medical advice, does not establish a doctor-patient relationship, and is not a substitute for care from a licensed healthcare provider.</p>
```

Next:
- always → step 10 (`e2`)

<details><summary>Full step definition</summary>

```json
{
  "id": "e1",
  "type": "send_email",
  "subject": "Welcome — Let's Get You Ready for Your First Coaching Call",
  "template": "<p>Hi {{contact.first_name}},</p><p>Welcome, and congratulations on taking action early. Catching hair changes in their earliest stages is one of the biggest advantages you can give yourself, and I'm glad to be your coach through this.</p><p>First, an important note about what this is (and isn't)</p><p>I want to be completely clear from the start: this is a lifestyle and wellness coaching relationship. I am your coach, not your doctor. Our work together does not create a doctor-patient relationship, I do not diagnose medical conditions, and I do not prescribe or manage medications. My role is to guide you toward the habits, nutrition, stress management, and tracking practices that support the healthiest possible hair — and to help you become an informed, organized partner in your own care.</p><p>As a coach, I am not able to prescribe medications. However, as we have discussed, your enrollment includes a $2,000 program credit that can be applied toward the cost of any treatments you may ultimately need. Whether any such treatments are appropriate for you is a decision made between you and a licensed clinician. During our first one-on-one coaching session, we will review your goals and circumstances together that are customized to you and your specific stage. From here I will help guide you toward reputable resources—including over-the-counter options and licensed telehealth providers—so you can obtain exactly what you need from the appropriate source.</p><p>Here are your next steps before our first call coming up...</p><p>To make our first session as productive as possible, please complete as many of the following as you can:</p><p>1. Complete your intake questionnaire. This is the single most important step — it tells me about your history, lifestyle, and goals so we don't spend our call gathering basics. https://saveyourhairtoday.com/in-take</p><p>2. Take your baseline \"before\" photos. Use consistent lighting (same spot, same time of day), the same distance, and capture four views: front/hairline, top/crown looking down, and both sides. Keep the same phone and angle each time so future photos are truly comparable. We'll use these to track progress objectively over the months ahead. Take those photos and send directly to me via telegram at the telegram account below</p><p>3. Make a list of everything you currently take. Include all prescription medications, over-the-counter products, vitamins, and supplements — with doses. Some common medications and supplements can affect hair, and your clinician will want an accurate list too. Send that to me in our 1-on-1 thread in the telegram below</p><p>4. Note any recent major life events or health changes in the last 6–12 months — significant stress, illness, rapid weight change, dietary changes, or new medications. These often matter for the timeline of hair changes. Send that to me in our 1-on-1 thread in the telegram below</p><p>5. Do a quick honest audit of four lifestyle anchors: sleep (hours and quality), nutrition (especially protein and overall diet quality), stress level, and smoking/alcohol use. Just jot down where you honestly stand — no judgment, this is our starting point. Send that to me in our 1-on-1 thread in the telegram below</p><p>6. Think about your goals and your \"why.\" What does success look like to you in 6 and 12 months? Being specific helps us set realistic, honest expectations together. Send that to me in our 1-on-1 thread in the telegram below</p><p>7. Set aside a private, quiet 45–60 minutes for our first call, with your photos and lists in front of you. Book your call here https://calendly.com/allan-saveyourhairtoday</p><p>A word on expectations</p><p>Hair responds slowly. Meaningful changes from lifestyle work and any medical treatments can take time. Our goal is by weeks 2 to 4, you'll see less hair coming out in the shower. This is the first sign the protocol is active. By month 6, most clients see 30 to 50% less scalp visibility in their progress photos. By weeks 12 to 24, existing follicles that were thinning start producing visibly thicker hair. So your consistency matters far more than intensity. We'll set clear, realistic milestones together on our first call so you always know what \"on track\" looks like.</p><p>If you have any questions before we talk, just reply to this email or text me in our telegram thread</p><p>Looking forward to getting started,</p><p>Dr. Allan Parungao</p><p>-The Hair Surgeon's Scorecard</p><p>Telegram: @DrEastside</p><p>This message is for general wellness and educational coaching purposes only. It is not medical advice, does not establish a doctor-patient relationship, and is not a substitute for care from a licensed healthcare provider.</p>",
  "kind": "transactional",
  "on_stale": "skip"
}
```

</details>

### 10. Welcome text

- Step id `e2`, type `send_sms`
- Engine description: Send text (automated receipt, may go out in dark hours)
- Goes to: the contact's phone (transactional)
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Text message:

```
Congrats on taking action to save your hair.

Your next steps have been emailed to you, please make sure to check your email for the subject line "Welcome -- Let's get you ready for your first coaching call" from Allan P.

Please follow the instructions in that email, and let us know if you have any issues
```

Next:
- always → step 11 (`a1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "e2",
  "title": "Welcome text",
  "type": "send_sms",
  "template": "Congrats on taking action to save your hair.\n\nYour next steps have been emailed to you, please make sure to check your email for the subject line \"Welcome -- Let's get you ready for your first coaching call\" from Allan P.\n\nPlease follow the instructions in that email, and let us know if you have any issues",
  "kind": "transactional",
  "on_stale": "skip"
}
```

</details>

### 11. AI writes from closer and more with the “close cheer” prompt

- Step id `a1`, type `analyze`
- Detail: Answer saved as cheer; skipped quietly when the AI cannot run
- If it keeps failing: after its tries it is skipped and the run goes on (optional: the steps after it go on without its answer)

AI prompt:

```
{{prompt.close_cheer}}
```

AI input:

```
Closer: {{contact.closer.name | default:the closer}}
Client first name: {{contact.first_name | default:the client}}
Cash collected: ${{contact.cash_collected | money}}
Deal value: ${{contact.revenue | money | default:unknown}}
Days from first booking to payment: {{contact.days_to_close | default:unknown}}
Lead source: {{contact.source | default:unknown}}
```

Next:
- always → step 12 (`s1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "a1",
  "type": "analyze",
  "prompt": "{{prompt.close_cheer}}",
  "input": "Closer: {{contact.closer.name | default:the closer}}\nClient first name: {{contact.first_name | default:the client}}\nCash collected: ${{contact.cash_collected | money}}\nDeal value: ${{contact.revenue | money | default:unknown}}\nDays from first booking to payment: {{contact.days_to_close | default:unknown}}\nLead source: {{contact.source | default:unknown}}",
  "into": "cheer",
  "format": "text",
  "max_tokens": 80,
  "optional": true
}
```

</details>

### 12. Post the win in Slack

- Step id `s1`, type `slack_post`
- Engine description: Post to Slack (the deals channel)
- Goes to: channel {{slack.channel.deals}}; posted as "NEW CLOSE"
- If it keeps failing: after its tries it is skipped and the run goes on (nothing later in the run reads what it does)

Slack post:

```
*NEW CLOSE!* Well done {{contact.closer.mention | default:team}}!
*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{contact.setter.mention | line:*Setter:*}}
*Cash Collected:* ${{contact.cash_collected | money}}
*Revenue Generated:* ${{contact.revenue | money | default:—}}

*First Booking:* {{contact.first_booked_at | date_company:ccc LLL d | default:—}}
*Days to Close:* {{contact.days_to_close | default:—}}

*Source:* {{contact.source | default:—}}{{vars.cheer | line:}}
```

Next:
- always → step 13 (`x1`)

<details><summary>Full step definition</summary>

```json
{
  "id": "s1",
  "title": "Post the win in Slack",
  "type": "slack_post",
  "channel": "{{slack.channel.deals}}",
  "template": "*NEW CLOSE!* Well done {{contact.closer.mention | default:team}}!\n*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{contact.setter.mention | line:*Setter:*}}\n*Cash Collected:* ${{contact.cash_collected | money}}\n*Revenue Generated:* ${{contact.revenue | money | default:—}}\n\n*First Booking:* {{contact.first_booked_at | date_company:ccc LLL d | default:—}}\n*Days to Close:* {{contact.days_to_close | default:—}}\n\n*Source:* {{contact.source | default:—}}{{vars.cheer | line:}}",
  "as": {
    "name": "NEW CLOSE",
    "icon": [
      ":tada:",
      ":boom:",
      ":partying_face:",
      ":bomb:",
      ":mirror_ball:",
      ":man_dancing:",
      ":dancer:",
      ":fire:",
      ":rocket:",
      ":champagne:"
    ]
  },
  "thread_only": false,
  "edit": false,
  "label": "mode"
}
```

</details>

### 13. Stop: closed

- Step id `x1`, type `exit`

Next: the run ends here.

<details><summary>Full step definition</summary>

```json
{
  "id": "x1",
  "type": "exit",
  "reason": "closed"
}
```

</details>

## Settings this workflow reads

| Key | Kind | Required to enable | Value |
| --- | --- | --- | --- |
| `crm.location_id` | id | yes | `WUtLNZJFg8QbFWyQhlH1` |
| `crm.object_sales_call` | id | no | `custom_objects.sales_call` |
| `crm.pipeline_closer` | id | yes | `TImaLginykFGirx5loC9` |
| `crm.pipeline_setter` | id | yes | `4J7CV5wJUTx1tyKhYRJb` |
| `crm.stage_closer_closed_won` | id | yes | `bff1a4e7-4c38-4c82-82e4-e78ada6884b5` |
| `prompt.close_cheer` | text | yes | `You write one line for a sales team's Slack channel the moment a deal closes. You are given the closer's name, the client's first name, cash collected, the deal value, how many days it took from first booking to payment, and the lead source. Write ONE sentence, under 25 words, congratulating the closer by name in the team's voice: upbeat, specific to the numbers you were given, never generic. Mention the days to close only if it is impressive (under 7). No emoji, no hashtags, no quotation marks, no preamble. Answer with the sentence only.` |
| `secret.anthropic_key` | secret | yes | set (secret, not shown) |
| `slack.channel.deals` | channel | no | `C0C7QCTHL8L` |

## Engine rules that apply but are not steps

These act on every run of this workflow from engine code. They are not in the definition above.

- **Mode.** The workflow's own mode, else the offer's, decides what is real: ghost writes and sends nothing, test is real only for test contacts, quiet writes the CRM but reaches no contact, live is real. (platform/src/engine/mode.ts:23, platform/src/engine/mode.ts:55)
- **Runs again?** A run's key is built from the re-entry policy; a second trigger with the same key starts nothing. A run that stops at a gate does not count. (platform/src/engine/reentry.ts:6)
- **Premise re-check.** Before each step the engine reads the CRM live; when "contact exists" no longer holds, the run exits. (platform/src/engine/runner.ts:33)
- **Failures.** Errors are sorted into transient, auth, permanent and unknown. A step is retried after 1 and 5 minutes; then a non-blocking step is skipped and a blocking one is held and looked at again after 15 minutes, then hourly. An auth or permanent failure pauses the run until it is fixed. (platform/src/engine/failures.ts:19, platform/src/engine/failures.ts:21, platform/src/engine/blocking.ts:58)
- **Step cap.** At most 50 steps run in one go; a run past that fails. After an outage, at most 20 sends per offer per tick. (platform/src/engine/runner.ts:21, platform/src/engine/runner.ts:27)
- **Before any text or email goes out**, in this order: SMS switched on for the offer; timing still valid; the CRM's own template if named; the words rendered; the contact has the address; the mode holds it; already sent for this run and step (idempotency key run:step); already sent before a replay; Do Not Disturb; the send lock; then the CRM. A send the CRM did not clearly answer is never sent again. (platform/src/engine/executor.ts:170)
- **Send lock.** While locked, a text, email, document or webhook reaches a contact only when their live CRM phone or email is one of the operator's own. Changing any outbound step relocks the workflow. (platform/src/engine/send-lock.ts:27, platform/src/engine/send-lock.ts:97)
- **Send window.** A text or email due outside the offer's send window waits until it opens, in the contact's time zone; a transactional one may go at any hour when the offer allows it. (platform/src/engine/runner.ts:274)
- **CRM writes** without a natural key (notes, tasks, cards, records) are claimed once per run and step so a retry never writes twice. In ghost mode they are skipped. (platform/src/engine/effects.ts:13)
- **Slack before live.** Until the workflow is live, every post goes to the offer's test channel with a ghost/test label, unless `slack.live` is set. (platform/src/engine/mode.ts:32, platform/src/engine/mode.ts:34)
