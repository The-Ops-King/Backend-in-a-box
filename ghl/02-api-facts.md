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
