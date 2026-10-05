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
