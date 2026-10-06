# Calendly API — verified facts (2026-10-06)

Base `https://api.calendly.com`, `Authorization: Bearer <token>`. Personal access tokens (PAT) are
per user; a read-only PAT with `scheduled_events:read event_types:read users:read organizations:read`
is enough for polling. Verified against the Save Your Hair organization with Dr Alan's token.

| Fact | Detail |
|---|---|
| Who am I | `GET /users/me` → `resource.uri`, `resource.current_organization`. Needed for everything else. |
| Members | `GET /organization_memberships?organization=<uri>` → `user.uri`, `user.email`, `role`. Resolves a host email to a user uri. |
| Event types | `GET /event_types?user=<uri>` lists that host's types **including round-robin ones**. `?organization=<uri>` omits round-robin types (verified: 5 returned, the two strategy call types missing). Always list by user. |
| Internal note | `event_types[].internal_note` — Hair uses it to mark "Round Robin for Direct Booking" vs "Setter - <name>". We read it at install and store `self_booked` per calendar; we never parse it at runtime. |
| Scheduling link | `event_types[].scheduling_url` → `calendars.booking_url` → `{{calendar.*.url}}`. |
| Events | `GET /scheduled_events?organization=&user=&min_start_time=&max_start_time=&count=100&sort=start_time:asc`, paginated by `pagination.next_page` (full URL). `status` is `active` or `canceled`. No "updated since" filter: poll a window and diff, same as GHL calendars. |
| Invitee | `GET /scheduled_events/{uuid}/invitees` → `email`, `name`, `first_name`/`last_name` (may be null), `timezone`, `text_reminder_number`, `questions_and_answers[]`, `rescheduled`, `old_invitee`, `new_invitee`, `no_show`, `cancellation`. One request per event; we cache by `(event uri, updated_at)`. |
| Links + tracking | Invitee `reschedule_url` and `cancel_url` are per booking (stored on the appointment; `{{appointment.reschedule_url}}`). `invitee.tracking` carries `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `salesforce_uuid` (stored as `appointments.tracking`). |
| Setter | On the setter event type the second question is the setter's name (Hair: label "Setter"); `calendly.setter_question` names it per company, matched exactly, and lands in `appointments.set_by`. |
| Phone | Usually a custom question (Hair: "Phone Number"), sometimes `text_reminder_number`. The question label is a per-company setting (`calendly.phone_question`), matched exactly. |
| Reschedule | Calendly cancels the old event and creates a new one. Old invitee: `rescheduled: true`, `new_invitee` = uri of the new invitee. New invitee: `old_invitee` = uri of the old one. Invitee uris embed the event uuid (`/scheduled_events/{event}/invitees/{invitee}`). A plain cancellation has `rescheduled: false` and no pointers. |
| Rate limit | Headers `x-ratelimit-limit: 500`, `x-ratelimit-remaining`, `x-ratelimit-reset: 60` (per minute, per token). 429 → back off. One-minute polling of one host is ~5 requests/minute steady state. |
| Timestamps | ISO 8601 with six fractional digits (`2026-10-08T16:00:00.000000Z`). |
| Writes | None used. Cancelling via API exists (`POST /scheduled_events/{uuid}/cancellation`) but the engine treats Calendly as read-only. |
