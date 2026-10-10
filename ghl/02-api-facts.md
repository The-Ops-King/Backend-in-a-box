# GHL API — verified facts

Every line below was tested against a live location on 2026-09-12, not read in docs.
Where the docs disagree, the docs are wrong.

## Cannot be done via API

| Thing | Evidence |
|---|---|
| Create a workflow | `POST /workflows/` → `404 Cannot POST /workflows/`. No endpoint exists. |
| Delete a custom object schema | `DELETE /objects/{key}` → `"Deleting object schema is not supported yet"` |
| Change a custom field's key | `PUT` with `fieldKey` → `422 property fieldKey should not exist` |
| Calendar "Allow Staff Selection" | Not in the calendar property set |
| Calendar reschedule-owner preference | Not in the calendar property set |
| Read agency-level data with a location PIT | `/locations/search` → 403, `/snapshots/` → 401 |

## Docs claims that are false

**"10 unique fields per custom object."** Wrong. Tested by adding 20 TEXT fields to a live
object — all 20 accepted, 21 total with the primary. The limit describes `uniqueProperties`,
the array of fields flagged as unique identifiers. Not total field count.

**DATE custom fields do not store time.** Wrote `2026-10-15T14:30:00-07:00`, read back
`2026-10-15`. Truncated silently, no error, no warning. Any design that needs a timestamp
needs a second field or a join to the appointment.

## Confirmed true

| Thing | Detail |
|---|---|
| Custom objects travel in snapshots | Up to 10 per sub-account |
| Associations travel | Included by default, **cannot be deselected** |
| Object field labels are renamable | `PUT /custom-fields/{id}` with `name` only |
| Object fields are deletable | 20/20 deleted cleanly |
| Association data is API-readable | `GET /associations/relations/{recordId}` → 200 |
| Users do not travel in snapshots | Must be recreated per install |

## Gotchas that cost time

**Cloudflare blocks Python `urllib`** on this API by TLS fingerprint — every request returns
`Error 1010: Access denied` with a 403. `curl` works. Anything scripted has to shell out to
curl or use a client with a browser-like TLS stack. This will matter for the dashboard.

**Contact field folders and object field folders use different endpoints.**
- Contact: `POST /locations/{loc}/customFields` with `documentType: "folder"`
- Object: `POST /custom-fields/folder` with `objectKey`
- Calling the object endpoint with `objectKey: "contact"` returns
  `"Api does not support objectKey of type contact or opportunity"`

**Custom object keys must be namespaced.** `zz_test_obj` → `400 Invalid key`.
`custom_objects.zz_test_obj` → works.

**Creating a user auto-creates a personal calendar** for that user. Three users, three extra
calendars. Deselect them at snapshot time.

**The `* ` field-name prefix becomes `_` in the key.** `* lead_source` → `contact._lead_source`.
Predictable, but worth knowing before writing anything that references keys.

---

## Send path (verified 2026-10-05, new PIT)

`POST /conversations/messages` — version header `2021-04-15`, **not** `2021-07-28`.

Takes `contactId` (no need to look up or create a conversation first — GHL creates
the thread and returns `conversationId`). Works for both channels:

```
{"type":"Email","contactId":"<id>","subject":"...","html":"...","emailFrom":"jt@jtylerray.com"}
{"type":"SMS","contactId":"<id>","message":"..."}
```

Both returned `201` with a `messageId` + `conversationId`. Message appears in the
contact's conversation thread immediately, `direction: outbound`, tagged with the
integration's `appId` in `meta.marketplace` — so sends made this way are
distinguishable from sends made by a human in the UI.

### Delivery status is readable
`GET /conversations/messages/{messageId}` returns `status` and a human-readable
`error`. The SMS test failed with:

> `Failed: No numbers available in the account. Buy a number to send SMS.`

That is an account provisioning gap, not an API limit. A number must be purchased
in each sub-account before SMS sends. Email needed no provisioning.

`GET /conversations/{conversationId}/messages` lists the thread. Email `status` came
back `null` at send time; SMS populated immediately. Don't rely on email `status` —
poll the message, or take delivery truth from the email provider.

### Scheduled sends work, and are cancellable
`scheduledTimestamp` is accepted — **Unix seconds, not milliseconds** (ms returns a
422 that says so explicitly). Cancel with:

```
DELETE /conversations/messages/email/{emailMessageId}/schedule
```

Returned `200 "Cancelled the scheduled email successfully!"`.

**Decision: don't use it.** Our scheduler owns timing. Handing a future send to GHL
means two systems hold the same pending action, and every exit condition has to
remember to cancel on their side too. We hold `next_run_at` and send at fire time.

---

## Inbound / receiving surface (verified 2026-10-06)

### There is no webhook management API for a PIT
All 404, not 401 — meaning no such route, not a scope problem:
`/hooks/`, `/webhooks/`, `/hooks/?locationId=`, `/webhooks/?locationId=`,
`/locations/{loc}/webhooks`.

Agency/marketplace routes are 401 by token class as before: `/marketplace/app`,
`/oauth/installedLocations`.

So a PIT cannot subscribe to events. Three ways to receive, in order of preference:

1. **A thin GHL workflow per event that POSTs to our endpoint.** GHL workflows have a
   Webhook action. One trigger, one POST, nothing else. These travel in a snapshot, so
   they're install-time config, not per-client build work. Lowest latency.
2. **Marketplace app** — real event subscriptions (AppointmentCreate/Update etc.), but
   requires building and maintaining a marketplace app and an OAuth install flow per client.
   Correct eventually, overkill now.
3. **Polling** — confirmed working, see below. The reconciliation backstop regardless of
   which of the above is primary.

`GET /workflows/?locationId=` returns 200 (empty list here). Read-only — still no create.

### Polling appointments works
```
GET /calendars/events?locationId={loc}&calendarId={cal}&startTime={ms}&endTime={ms}
```
200. Requires **one of** `userId`, `calendarId`, or `groupId` — a 422 says so if omitted.
So poll per calendar and loop; there were 6 calendars in this location.

Each event carries `appointmentStatus`, `assignedUserId`, `startTime`, and `dateUpdated`.
No server-side `dateUpdated` filter, so poll a window and diff against what we hold.

### Appointment create requires a calendar team member
`POST /calendars/events/appointments` (version `2021-04-15`) needs `assignedUserId`, and
that user must be on the target calendar's team — a location user who isn't returns
`The user id not part of calendar team.` Read the roster from
`GET /calendars/{calendarId}` → `calendar.teamMembers[].userId`.

`ignoreFreeSlotValidation: true` is required to book outside published availability;
without it you get `The slot you have selected is no longer available.`

### ⚠️ PUT on an appointment silently resets `appointmentStatus` to `confirmed`
**This is the most dangerous behavior found so far.** The update is not a patch for this
field. Verified twice:

- Appointment set to `noshow`. PUT `{"assignedUserId": "..."}` → status came back `confirmed`.
- Appointment set to `noshow`. PUT `{"title": "ZZ retitled"}` → status came back `confirmed`.

`assignedUserId` is *not* clobbered the same way — it survives a title-only PUT. The defaulting
behavior is specific to `appointmentStatus`.

**Rule: never PUT an appointment without reading it first and re-sending
`appointmentStatus` explicitly.** Confirmed working: PUT with both `assignedUserId` and
`appointmentStatus` preserves both.

This matters most for bulk operations. "Reassign today's calls from Closer A to Closer B"
done naively wipes the status on every appointment it touches, which destroys show/no-show
data and re-fires any workflow keyed on that status.

### Response field typo
Appointment responses include both `appointmentStatus` and `appoinmentStatus` (sic), with
the same value. Read the correctly-spelled one; don't write the typo'd one.

### `statusDetails` carries transition info
```json
"statusDetails": {"status":"No Show","state":"noshow","oldStatus":"noshow","translatable":true}
```
`state` is the machine value and is more reliable to branch on than the display `status`.

### Appointment status enum — brute-forced 2026-10-06
Values GHL accepts on `appointmentStatus`, with the `statusDetails.state` each maps to:

| Sent | Stored | `statusDetails.state` |
|---|---|---|
| `new` | `new` | `pending` |
| `confirmed` | `confirmed` | `active` |
| `cancelled` | `cancelled` | `cancelled` |
| `showed` | `showed` | `completed` |
| `noshow` | `noshow` | `noshow` |
| `invalid` | `invalid` | `invalid` |
| `completed` | **`showed`** | `completed` |

Rejected: `no_show`, `no-show`, `pending`, `rescheduled`. The error is a bare
`appointmentStatus must be a valid enum value` with no list, hence the brute force.

Note `completed` is a write-alias that stores as `showed` — so never round-trip-compare the
value you sent against the value you read.

**`noshow` does exist** as a native GHL status. That does not change D12: outcome data is ours
and lives in our backend. But because the field exists, a client's own team will use it in the
GHL UI, which makes it a legitimate *trigger source* for us to read — and makes the PUT clobber
bug above a risk to **their** data even though we never write ours there.

---

## Polling surface — incremental "what changed" per entity (verified 2026-10-06)

Everything needed to detect change without any GHL workflow or marketplace app.

| Entity | Call | Incremental by |
|---|---|---|
| Contacts | `POST /contacts/search` with `filters:[{field:"dateUpdated",operator:"range",value:{gte:ISO}}]`, `sort:[{field:"dateUpdated",direction:"desc"}]` | `dateUpdated` cursor |
| Appointments | `GET /calendars/events?locationId&calendarId&startTime&endTime` (one call per calendar) | time window + `dateUpdated` diff |
| Conversations | `GET /conversations/search?locationId&sortBy=last_message_date&sort=desc&lastMessageDirection=inbound` | last inbound message date |
| Opportunities | `GET /opportunities/search?location_id&date=MM-DD-YYYY` (also `order=updatedAt`) | date + updatedAt diff |

Operator gotchas: contacts search wants `operator:"range"` with a `{gte,lte}` object — a flat
`gt`/`gte` is a 422 (`Invalid Operator`). Opportunities `date` is `MM-DD-YYYY`, not ISO.

### Rate limits (from response headers)
```
x-ratelimit-max: 100            # burst
x-ratelimit-interval-milliseconds: 10000
x-ratelimit-limit-daily: 200000 # per location
```
A 1-minute poll of ~10 calls per client is ~14,400/day per location — 7% of the daily budget.

### Contact search index lags writes by ~10 seconds (measured twice, 2026-10-06)
Tagged a contact and polled `POST /contacts/search` (by `dateUpdated` range) every 3 seconds:

| after the write | search returns | `tags` | `dateUpdated` |
|---|---|---|---|
| +0s to +4s | the **old** record | `[]` | old value |
| ~+7s | nothing | — | — |
| +10s onward | the new record | `['reactivate']` | new value |

`GET /contacts/{id}` is correct immediately. Two consequences for the poller:

1. The stale copy carries the **old** `dateUpdated`, so a cursor set to the max seen never
   advances past the real change. The next poll picks it up. Worst case: one poll late.
2. New contacts show the same lag: a contact created seconds before a poll may not be returned
   until the next one.

Verified end to end: tag in GHL → next engine tick → `tag.added` → reactivation run started.
No engine change needed; don't add a per-contact `GET` on every poll for a delay shorter than
the poll interval.

## Opportunities (pipeline cards) — added 2026-10-06
| Fact | Detail |
|---|---|
| Pipelines + stages | `GET /opportunities/pipelines?locationId=` (Version 2021-07-28) → `pipelines[].stages[]` with ids. |
| Create | `POST /opportunities/` body `{ locationId, contactId, pipelineId, pipelineStageId, name, status: "open", assignedTo?, customFields?: [{ id, field_value }] }` → `opportunity.id`. Status enum: open, won, lost, abandoned. |
| Update | `PUT /opportunities/{id}` with any subset of the same fields (`pipelineStageId` moves the card). |
| Search | `GET /opportunities/search?location_id=&contact_id=&pipeline_id=&limit=` — **snake_case** params here, camelCase returns 422. Index lags a few seconds after a create. |
| Custom fields | `GET /locations/{id}/customFields?model=opportunity` → ids. DATE fields accept `YYYY-MM-DD`. |
| Tasks | `POST /contacts/{id}/tasks` body `{ title, body, dueDate (ISO), completed: false, assignedTo? }` → `task.id`. |
| Clearing a custom field | `PUT /contacts/{id}` with `customFields: [{ id, field_value: "" }]` returns 200; for some field types (native phone, possibly DATE) the empty write is accepted and ignored. Read back to be sure. |

## Calls in the conversation thread (verified 2026-10-07, Hair location)

- A phone call is a message with `messageType: "TYPE_CALL"` in `GET /conversations/:id/messages`
  (Version 2021-04-15). Fields: `direction`, `status` (`completed` | `no-answer` | `failed` | `busy` |
  `voicemail` | `canceled`), `userId` (who dialed), `meta.call.duration` (seconds, present only when
  it connected), `meta.call.status`, `dateAdded` (call end-ish), `altId` (the carrier call sid). No body.
- Recording: `GET /conversations/messages/:messageId/locations/:locationId/recording` streams the
  WAV (`audio/x-wav`, ~1 MB/min) with 200, or 422 when the call was not recorded. No HEAD. Opening
  that URL needs the bearer token, so it is not a link for Slack.
- Transcription: `GET /conversations/locations/:locationId/messages/:messageId/transcription`
  (Version 2021-04-15) returns an **array** of `{speaker: 0|1, mediaChannel, sentenceIndex,
  transcript, startTime, endTime, words}` when it exists, and 400
  `CONVERSATIONS_MSG_RECORDING_NOT_FOUND` ("Transcription does not exist") otherwise. Speaker 0 is the
  dialer's side. The Zap's note that this endpoint "never returned content" was wrong for this account.
- Recording is not on for every call: 2 of 4 connected calls over a minute had one. A connected
  172-second call had none 30 minutes after it ended, so "not yet" and "never" look identical.
- `TYPE_ACTIVITY_*` entries (opportunity moved, appointment booked) sit in the same list and are not
  messages from the contact.
- The conversation deep link people can open: `https://app.gohighlevel.com/v2/location/:loc/conversations/conversations/:contactId`.
- Custom object `custom_objects.discovery_call` on Hair: display_label, external_id, contact_id,
  occurred_at (TEXT), direction (inbound|outbound), duration_sec (NUMERICAL), setter, outcome
  (connected|voicemail|no_answer|busy|failed), recording_url, led_to_booking (CHECKBOX, option `yes`,
  written as `["yes"]`). Association `6aa08fc3b1739b9f7dd9f337` is contact → discovery_call.


## Reads behind the Slack bot's numbers (D73, 2026-10-10; from the published API v2 spec, not yet re-verified live)

| Read | Call | Paging / fields |
|---|---|---|
| Contacts added in a window | `POST /contacts/search` (Version 2021-07-28) `{locationId, pageLimit ≤ 500, filters:[{field:"dateAdded",operator:"range",value:{gte,lte}}], sort:[{field:"dateAdded",direction:"asc"}]}` | each contact carries `searchAfter`; send the last one back as `searchAfter` (not capped at 10,000 like `page`). `customFields: [{id, value}]`. |
| Won cards on one board | `GET /opportunities/search?location_id&pipeline_id&status=won&limit=100&page=N` | status enum open, won, lost, abandoned, all. Won time = `lastStatusChangeAt` (fallback `lastStageChangeAt`, then `updatedAt`). The card embeds `contact {id, name, email, tags}`, `monetaryValue`, `assignedTo`. |
| Custom object records | `POST /objects/{key}/records/search` `{locationId, page, pageLimit, query:""}` | records carry `searchAfter` and `properties`; no property filter in the spec, so all records are read and filtered here. Hair's `custom_objects.sales_call` records (object 6a8d189363abc358ea394676) were made by an outside integration: their `external_id` is not the ledger's Calendly event uuid, so they are matched by GHL contact id and start minute. |

## Contact attribution (D78; keys from the published API v2 spec, checked against Hair's live contacts 2026-10-10)

`GET /contacts/{id}` and `POST /contacts/search` return two objects on each contact: `attributionSource` (the first touch)
and `lastAttributionSource` (the latest). The spec's `AttributionSource` keys: `url`, `campaign`, `utmSource`, `utmMedium`,
`utmContent`, `referrer`, `campaignId`, `fbclid`, `gclid`, `msclikid`, `dclid`, `fbc`, `fbp`, `fbEventId`, `userAgent`,
`ip`, `medium`, `mediumId`. Live contacts also carry `sessionSource` ("Social media", "Third Party", "CRM UI"…), `utmTerm`,
`utmKeyword` and `gaClientId`. The campaign is `campaign`, not `utmCampaign`. `medium` is how the record came in (`form`,
`zapier`, `manual`/`Manual`), not the UTM medium. The spec's search schema documents an `attributions` array instead; the
adapter reads that form too (`isFirst` / `isLast`, else first and last). Hair, October's 60 leads: `utmSource` fb 38, ig 17;
the rest have only `medium` (zapier 4, manual 1). The top-level `source` is the record's origin label ("Optin Form").

