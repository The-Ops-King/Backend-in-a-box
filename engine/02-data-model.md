# Engine — data model

Postgres 16. One database, `company_id` on every tenant table, row-level security enforces
isolation (§12). Everything below follows the decisions in `00-decisions.md` and the grill-me
answers of 2026-10-06. Where I decided something without asking, it's marked **[decided]** so
it's visible.

**Executed, not just written.** `schema.sql` is §1–§9 extracted verbatim and run on Postgres 16
on 2026-10-06: 28 tables, 72 foreign keys, seeds loaded. A smoke test inserted a company → user →
term ("Strategy Session" is-a `first_call`) → calendar → contact → identifier → appointment through
the FK chain, then confirmed the database rejects a term with a category outside the core
vocabulary and a duplicate identifier within a company.

Earlier proofs against the same shape: `proof-journey.sql` (events, funnel, vocabulary FK) and
the JSONB attribute queries in `00-decisions.md` D9.

---

## 0. Conventions

- **Ids:** `uuid` primary keys we generate. External ids (`ghl_*`, `whop_*`, `slack_*`) are
  nullable, indexed, unique per company. Never a primary key.
- **Time:** every timestamp is `timestamptz` (UTC on disk). Timezones are stored as IANA names
  on the entity that owns them (`companies.timezone`, `contacts.timezone`), never baked into a
  timestamp.
- **Vocabulary:** a value that must mean the same thing everywhere is a foreign key to a lookup
  table, not a `text` column with a comment. The database refuses what the vocabulary doesn't know.
- **Names:** `company` is the tenant. Not client, not offer, not tenant. One offer per company;
  a second offer is a second company record sharing a login.
- **Soft state:** nothing is hard-deleted on churn. `companies.status = 'archived'`, purge is a
  setting (default 12 months), the purge itself is logged.
- **Derived state is a cache, never a truth.** `contacts.attributes` is the merge of `intake`
  rows. `opportunities.status` is set by rules reading events. Both can be rebuilt from the
  stream.
- **The CRM replica is a cache too (D68).** `contacts`, `contact_identifiers`, `pipeline_cards`
  mirror GoHighLevel so the engine can match, diff and render without a round trip, but the CRM
  is the record. Before a run acts, the contact is read live and folded into the replica
  (`contact-truth.ts`); before a card step, the cards are (D41). The poll keeps the replica warm
  and is the only thing that turns a change into an event (a new lead, a tag added); a live read
  before a run folds everything but `tags`, which it leaves for the poll to diff. When the CRM
  does not answer, the replica stands in and the run says so (`contact.stale`). The engine is
  workflows plus statistics, not storage for everything.

---

## 1. Tenancy and people

```sql
create table companies (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text not null unique,
  timezone          text not null,                      -- IANA, e.g. America/Phoenix
  send_window_start time not null default '08:00',
  send_window_end   time not null default '20:00',
  sms_enabled       boolean not null default true,      -- false when the sub-account has no number; SMS nodes skip
  mode              text not null default 'shadow' check (mode in ('shadow','live')),  -- shadow: run everything, write nothing to the CRM, record what would have gone out
  status            text not null default 'active'
                    check (status in ('onboarding','active','hosted','archived')),
  archived_at       timestamptz,
  purge_after_months int not null default 12,
  -- opportunity lifecycle rules (per-company settings, Tyler: "depends on workflow and settings")
  opp_opens_on      text not null default 'first_booking'
                    check (opp_opens_on in ('lead_created','first_booking','pipeline_entry')),
  opp_won_on        text not null default 'first_payment'
                    check (opp_won_on in ('first_payment','closer_marks','paid_in_full')),
  opp_lost_on       text not null default 'closer_marks_or_inactive'
                    check (opp_lost_on in ('closer_marks','closer_marks_or_inactive')),
  opp_inactive_days int not null default 90,
  created_at        timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),            -- null = operator (Tyler)
  email         text not null,
  name          text not null,
  role          text not null
                check (role in ('operator','owner','manager','closer','setter')),
  ghl_user_id   text,
  slack_user_id text,
  claimed_at    timestamptz,       -- null = auto-created from GHL roster, not yet logged in
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, email),
  unique (company_id, ghl_user_id)
);
```

`status` lifecycle: `onboarding` (install form in progress) → `active` (managed) → `hosted`
($500 tier, Tyler no longer managing) → `archived` (runway ended; workflows off, data kept).

---

## 2. Contacts and identity

```sql
create table contacts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  ghl_contact_id  text,
  first_name      text,
  last_name       text,
  timezone        text,                                   -- IANA or null
  timezone_source text check (timezone_source in ('ghl','phone','company_default')),
  tags            text[] not null default '{}',           -- replica of GHL tags
  ghl_fields      jsonb not null default '{}',            -- human-entered GHL custom fields (replica)
  attributes      jsonb not null default '{}',            -- DERIVED: merge of intake rows, ours
  merged_into     uuid references contacts(id),           -- set when this record was folded into another
  gone_at         timestamptz,                            -- the CRM said "contact not found" at a send or write: deleted or merged there; runs about them exit moot
  ghl_updated_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, ghl_contact_id)
);
create index on contacts using gin (attributes);
create index on contacts (company_id, updated_at);

-- Identity resolution. A person arrives as an email from a form, a phone from GHL, a customer id
-- from Whop. Any match on any identifier resolves to the same contact; a new identifier attaches.
create table contact_identifiers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  contact_id  uuid not null references contacts(id),
  kind        text not null check (kind in ('email','phone','ghl_contact','whop_customer')),
  value       text not null,                              -- normalized: lowercase email, E.164 phone
  created_at  timestamptz not null default now(),
  retired_at  timestamptz,                                -- the CRM record moved to another number/email: kept for history, never matched again
  unique (company_id, kind, value)
);
```

**Merge rule [decided]:** when an incoming identifier matches contact A and a second identifier on
the same record matches contact B, the newer contact is merged into the older: identifiers,
events, appointments, opportunities, payments and intake rows are re-pointed; the newer row gets
`merged_into`; a `contact.merged` event is written on the survivor. Nothing is deleted.

---

## 3. Vocabulary — core categories and each company's own words

```sql
-- The fixed core. Seeded, not editable per company. What makes "show rate" comparable everywhere.
create table core_categories (
  domain text not null,
  value  text not null,
  label  text not null,
  sort   int  not null default 0,
  primary key (domain, value)
);
insert into core_categories (domain, value, label, sort) values
  ('appointment_type','first_call','First call',1), ('appointment_type','qualifying','Qualifying',2),
  ('appointment_type','closing','Closing',3),        ('appointment_type','follow_up','Follow-up',4),
  ('appointment_outcome','showed','Showed',1),       ('appointment_outcome','noshow','No-show',2),
  ('appointment_outcome','cancelled','Cancelled',3), ('appointment_outcome','rescheduled','Rescheduled',4),
  ('call_outcome','qualified','Qualified',1),        ('call_outcome','unqualified','Unqualified',2),
  ('call_outcome','follow_up','Follow-up',3),        ('call_outcome','closed','Closed',4),
  ('call_outcome','lost','Lost',5),
  ('payment_plan','pif','Paid in full',1),           ('payment_plan','installments','Installments',2),
  ('lost_reason','price','Price',1), ('lost_reason','timing','Timing',2), ('lost_reason','fit','Fit',3),
  ('lost_reason','ghosted','Ghosted',4), ('lost_reason','other','Other',5),
  ('reply_intent','confirmed','Confirmed',1), ('reply_intent','cancelled','Cancelled',2),
  ('reply_intent','reschedule_request','Reschedule request',3), ('reply_intent','question','Question',4),
  ('reply_intent','unclear','Unclear',5);

-- A company's own words. "Strategy session" is-a first_call. Free name, one-time category pick.
create table company_terms (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  domain      text not null,
  name        text not null,                 -- their word, shown everywhere they look
  category    text not null,                 -- the core value, used by every report
  is_default  boolean not null default false,
  sort        int not null default 0,
  active      boolean not null default true,
  foreign key (domain, category) references core_categories(domain, value),
  unique (company_id, domain, name)
);
```

At install, every core value is copied into `company_terms` with `name = label`, so a company
that never renames anything still has rows to reference. Renaming is an `update` on `name`.

---

## 4. Attribute schemas — the form is the schema

```sql
create table attribute_schemas (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  key              text not null,                           -- hair_loss_level
  label            text not null,                           -- "How bad is your hair loss?"
  type             text not null check (type in ('integer','number','text','enum','boolean','date')),
  enum_values      text[],
  min_value        numeric,
  max_value        numeric,
  required         boolean not null default false,
  -- type changes are allowed in place; this is the bookkeeping that keeps reclassification possible
  previous_type    text,
  type_changed_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (company_id, key)
);
```

Ingest validates every submitted value against the schema **as of submission time** and refuses
a mismatch. A query that spans a type change filters on `submitted_at` against
`type_changed_at` — two clean populations instead of one mixed column.

---

## 5. Calendars, opportunities, appointments, payments

```sql
create table calendars (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  source           text not null default 'ghl' check (source in ('ghl','calendly')),
  external_id      text not null,      -- GHL calendar id or Calendly event type uuid
  name             text not null,
  appointment_term uuid not null references company_terms(id),   -- which kind of call this calendar books
  default_user_id  uuid references users(id),
  active           boolean not null default true,
  self_booked      boolean,            -- every booking on this calendar is self-booked / setter-booked; null = unknown
  booking_url      text,               -- public scheduling link behind {{calendar.*.url}}
  unique (company_id, source, external_id)
);

-- One pursuit of a sale. Holds N appointments. Ends won (= a deal) or lost.
create table opportunities (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  contact_id          uuid not null references contacts(id),
  ghl_opportunity_id  text,
  status              text not null default 'open' check (status in ('open','won','lost')),
  opened_at           timestamptz not null default now(),
  opened_by           text not null,                    -- rule or event that opened it
  won_at              timestamptz,
  lost_at             timestamptz,
  lost_reason_term    uuid references company_terms(id),
  contract_value      numeric(12,2),
  payment_plan_term   uuid references company_terms(id),
  installments        int,
  created_at          timestamptz not null default now(),
  unique (company_id, ghl_opportunity_id)
);
create index on opportunities (company_id, contact_id, status);

-- CRM custom-object records the engine owns, keyed by what identifies them to us (never by the CRM's search).
create table crm_records (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  object_key     text not null,          -- custom_objects.payment
  record_key     text not null,          -- provider payment id, Calendly event uuid, …
  ghl_record_id  text,                   -- null in shadow
  contact_id     uuid references contacts(id),
  properties     jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, object_key, record_key)
);

create table appointments (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id),
  contact_id           uuid not null references contacts(id),
  opportunity_id       uuid references opportunities(id),
  source               text not null default 'ghl' check (source in ('ghl','calendly')),
  external_id          text not null,  -- GHL appointment id or Calendly scheduled event uuid
  calendar_id          uuid references calendars(id),
  appointment_term     uuid not null references company_terms(id),  -- from the calendar at booking; overridable
  assigned_user_id     uuid references users(id),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  self_booked          boolean,
  set_by               text,               -- setter's name when the booking source carries it
  reschedule_url       text,               -- per-booking self-service links (Calendly)
  cancel_url           text,
  tracking             jsonb not null default '{}',   -- utm_* as the booking source reported them
  booked_at            timestamptz not null,
  -- replica of GHL's confirmation state
  status               text not null check (status in ('new','confirmed','cancelled','showed','noshow','invalid')),
  source_updated_at    timestamptz,
  -- ours: the outcome, written by the disposition form
  outcome_term         uuid references company_terms(id),          -- appointment_outcome domain
  call_outcome_term    uuid references company_terms(id),          -- call_outcome domain
  disposition_id       uuid,                                       -- → form_submissions
  dispositioned_at     timestamptz,
  dispositioned_by     uuid references users(id),
  created_at           timestamptz not null default now(),
  unique (company_id, source, external_id)
);
create index on appointments (company_id, starts_at);
create index on appointments (company_id, assigned_user_id, starts_at);

create table payments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  contact_id       uuid not null references contacts(id),
  opportunity_id   uuid references opportunities(id),
  whop_payment_id  text not null,
  amount           numeric(12,2) not null,
  currency         text not null default 'USD',
  installment_no   int,
  status           text not null check (status in ('succeeded','failed','refunded')),
  paid_at          timestamptz not null,
  raw              jsonb not null default '{}',          -- the small, structured part of the webhook
  unique (company_id, whop_payment_id)
);
create index on payments (company_id, opportunity_id);
```

```sql
-- Daily rollups, report schedules and generated wrap-ups (D29) are in schema.sql after recordings: rollups_daily (counts and sums per
-- company/day/dimension/metric, recomputed from the ledger), wrapups (as sent; the clock, channel and breakdowns are the wrap-ups workflow's steps, D35).
-- Setter metrics (D64: leads assigned, dials, connected, speed to lead median/average, bookings that followed) are computed live from the ledger by
-- `setterMetrics` — no table, a median needs every lead's own number. The operator's read-only query door (`POST /api/admin/query`) runs one SELECT under this policy.
-- Agreements (D30) are in schema.sql after the rollups: one row per Documents & Contracts document (signer contact, status, sent_at, signed_at set once).
-- Call recordings (D22). Same shape as payments: a row per recording the provider reports, linked or not.
-- Phone calls the CRM's dialer logs live here too (D28): provider 'ghl', external_id = the TYPE_CALL message id, linked_by 'contact',
-- raw = {kind:'phone', direction, call_status, call_status_raw, duration_sec, caller_ghl_user_id, transcript_status: pending|ready|none, baseline?}.
create table recordings (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  contact_id       uuid references contacts(id),
  appointment_id   uuid references appointments(id),
  provider         text not null default 'fathom',
  external_id      text not null,                        -- Fathom recording id
  title            text,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  duration_min     int,
  url              text,
  share_url        text,
  recorded_by_email text,
  recorded_by_name text,
  invitees         jsonb not null default '[]',          -- [{name, email, isExternal}]
  transcript       jsonb,                                -- [{speaker, email, text, timestamp}]
  summary          text,
  analysis         jsonb not null default '{}',          -- what analyze nodes produced, keyed by `into`
  link_status      text not null default 'unlinked' check (link_status in ('linked','unlinked')),
  linked_by        text,                                 -- email | name | calendar | manual
  unlinked_reason  text,
  raw              jsonb not null default '{}',
  received_at      timestamptz not null default now(),
  unique (company_id, provider, external_id)
);
```

`total_collected ≥ contract_value` — the thing GHL couldn't do — is
`sum(amount) filter (where status='succeeded')` grouped by `opportunity_id`, compared to
`opportunities.contract_value`. The engine emits `payment.paid_in_full` when it crosses.

---

## 6. Events — the journey

```sql
create table event_types (
  name     text primary key,
  category text not null
);
insert into event_types values
  ('lead.created','lead'), ('intake.recorded','lead'), ('contact.merged','lead'),
  ('opportunity.opened','opportunity'), ('opportunity.won','opportunity'), ('opportunity.lost','opportunity'),
  ('appointment.booked','appointment'), ('appointment.rescheduled','appointment'),
  ('appointment.status_changed','appointment'), ('appointment.outcome','appointment'),
  ('call.held','call'),
  ('message.sent','message'), ('message.received','message'), ('reply.classified','message'),
  ('payment.received','payment'), ('payment.failed','payment'), ('payment.paid_in_full','payment'),
  ('payment.refunded','payment'), ('payment.unlinked','payment'), ('payment.linked','payment'),
  ('recording.received','call'), ('recording.unlinked','call'), ('recording.linked','call'), ('call.analyzed','call'),
  ('tag.added','crm'), ('tag.removed','crm'), ('stage.changed','crm'), ('card.moved','crm'),
  ('run.started','engine'), ('run.exited','engine'), ('send.suppressed','engine');

create table events (
  id              bigserial primary key,
  company_id      uuid not null references companies(id),
  contact_id      uuid references contacts(id),
  opportunity_id  uuid references opportunities(id),
  appointment_id  uuid references appointments(id),
  run_id          uuid,
  event_type      text not null references event_types(name),
  occurred_at     timestamptz not null,
  source          text not null check (source in ('form','ghl_poll','whop','fathom','zapier','slack','engine','disposition','command_center','user','test')),
  data            jsonb not null default '{}'
);
create index on events (company_id, contact_id, occurred_at);
create index on events (company_id, event_type, occurred_at);
create index on events (company_id, opportunity_id);
```

`event_types` is the only place a new event type can come from. Adding one is a migration.

---

## 7. Forms

```sql
create table forms (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  purpose          text not null check (purpose in ('intake','disposition','eod')),
  appointment_term uuid references company_terms(id),  -- required when purpose = disposition
  name             text not null,
  version          int not null default 1,
  fields           jsonb not null,    -- [{key,label,type,required,enum_values,min,max,help}]
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (company_id, purpose, appointment_term)        -- one disposition form per call type
    deferrable initially deferred
);

create table form_submissions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  form_id         uuid not null references forms(id),
  form_version    int not null,
  contact_id      uuid references contacts(id),
  appointment_id  uuid references appointments(id),
  submitted_by    uuid references users(id),
  answers         jsonb not null,
  token_jti       text unique,                           -- signed-link id; a used token can't be replayed
  submitted_at    timestamptz not null default now()
);

create table intake (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  contact_id    uuid not null references contacts(id),
  submission_id uuid not null references form_submissions(id),
  attributes    jsonb not null,                           -- validated against attribute_schemas
  submitted_at  timestamptz not null
);
```

A disposition form's `fields` are the schema for that call type's outcome data; its answers land
on `appointments.disposition_id` and are summarized into `appointments.call_outcome_term` plus
an `appointment.outcome` and `call.held` event. Intake answers land in `intake` and are merged
forward into `contacts.attributes`.

---

## 8. Workflows

```sql
-- Operator-owned library. No company_id.
create table workflow_templates (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text,
  category     text not null,              -- speed_to_lead, reminders, no_show, reactivation, payments, replies
  version      int not null default 1,
  definition   jsonb not null,             -- §10
  manifest     jsonb not null,             -- §10, extracted on save
  published_at timestamptz
);

-- A company's copy. Edits create versions; the instance remembers where it came from.
create table workflows (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id),
  template_id       uuid references workflow_templates(id),
  template_version  int,
  name              text not null,
  current_version   int not null default 1,
  enabled           boolean not null default false,
  reentry_policy    text not null
                    check (reentry_policy in ('once_per_contact','once_per_appointment','once_per_opportunity','once_per_contact_per_window','always')),
  reentry_window    interval,                             -- for the per_window policy
  diverged          boolean not null default false,       -- edited since copy
  diverged_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table workflow_versions (
  id           uuid primary key default gen_random_uuid(),
  workflow_id  uuid not null references workflows(id),
  version      int not null,
  definition   jsonb not null,
  manifest     jsonb not null,
  saved_by     uuid references users(id),
  saved_at     timestamptz not null default now(),
  note         text,
  unique (workflow_id, version)
);

-- The boxes on top of a workflow. Stored as rows so "who cares about this event?" is one index hit.
create table workflow_triggers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  workflow_id  uuid not null references workflows(id),
  node_id      text not null,                             -- the trigger node's id in the definition
  event_type   text not null references event_types(name),
  match        jsonb not null default '{}',               -- predicate tree, §10
  enabled      boolean not null default true,
  unique (workflow_id, node_id)
);
create index on workflow_triggers (company_id, event_type) where enabled;

-- Manifest values, per company. Secrets encrypted at rest.
create table bindings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  key         text not null,                              -- crm.location_id, calendar.closer_call, slack.channel.closers
  kind        text not null check (kind in ('secret','id','text','channel','number')),
  value       bytea not null,                             -- encrypted for kind=secret; plain bytes otherwise
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now(),
  unique (company_id, key)
);
```

**Enable gate [decided]:** `workflows.enabled` can only become true when every manifest entry
with `required: true` has a row in `bindings`. Optional entries left unbound cause the nodes that
need them to skip with a visible warning in the run.

---

## 9. Runs, steps, sends, cursors

```sql
create table runs (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  workflow_id         uuid not null references workflows(id),
  workflow_version    int not null,                        -- pinned at start; edits never move a live run
  contact_id          uuid not null references contacts(id),
  opportunity_id      uuid references opportunities(id),
  appointment_id      uuid references appointments(id),
  trigger_id          uuid references workflow_triggers(id),
  triggered_by_event  bigint references events(id),
  status              text not null default 'active'
                      check (status in ('active','waiting','paused','completed','exited','failed')),
  current_node        text,
  next_run_at         timestamptz,                         -- THE clock. Null when not waiting.
  wake_on_reply       boolean not null default false,       -- true only while parked on wait_for_reply; an inbound message wakes these and nothing else
  wake_on_tag         text,                                 -- set while parked on wait_for_reaction, or while a non-blocking listener is armed: the tag of the Slack post whose tap wakes it (D53, D58)
  resume_node         text,                                 -- D58: where a run with an armed listener was parked, so `resume` can return it there after the decision path
  resume_at           timestamptz,                          -- D58: that parked step's own due time, kept intact across the jump
  context             jsonb not null default '{}',         -- resolved vars, last reply, etc.
  exit_reason         text,
  reentry_key         text not null,                       -- computed per policy; unique prevents double runs
  claimed_at          timestamptz,                         -- scheduler lease
  claimed_by          text,
  step_attempt        int not null default 0,              -- D66: tries of the current step so far; reset when it passes or a person retries
  step_error          text,                                 -- D66: the last error of the current step, as the vendor said it
  step_held           boolean not null default false,       -- D77: paused ON its step because a blocking step is down; the scheduler re-checks only that step (next_run_at) until it passes
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  unique (workflow_id, reentry_key)
);
create index on runs (status, next_run_at) where status in ('active','waiting');
create index on runs (company_id, contact_id);
alter table pipeline_cards add column created_by_run uuid references runs(id) on delete set null;   -- D66: a retried card step finds its own card

-- One row per node execution. This is the flow view and the debugger.
create table run_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references runs(id),
  node_id     text not null,
  node_type   text not null,
  status      text not null check (status in ('ok','skipped','stale','failed','waiting','paused')),   -- paused: the step itself asked for a person (a stale message escalated), D66
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  result      jsonb not null default '{}',
  error       text
);
create index on run_steps (run_id, started_at);

-- D66: the create ledger for steps whose vendor write has no key of its own. Claimed BEFORE the vendor is called,
-- marked done after; a retry that finds the claim knows the write may already be there.
create table step_effects (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  run_id       uuid not null references runs(id) on delete cascade,
  node_id      text not null,
  kind         text not null,                            -- note | task | document | card | record
  external_id  text,                                     -- what the vendor gave back, once it answered
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  unique (run_id, node_id, kind)
);

-- The idempotent send ledger. A retry can't double-send because the key already exists.
create table sends (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id),
  run_id             uuid references runs(id),
  run_step_id        uuid references run_steps(id),
  contact_id         uuid not null references contacts(id),
  channel            text not null check (channel in ('sms','email','slack')),
  idempotency_key    text not null unique,                 -- run_id:node_id:attempt-group
  rendered_body      text not null,                        -- what actually went out, after send-time render
  scheduled_for      timestamptz,
  sent_at            timestamptz,
  status             text not null check (status in ('queued','sent','failed','suppressed','shadow')),   -- shadow = would have sent
  suppressed_reason  text,                                 -- stale, quiet_hours_deferred, premise_dead, unbound
  external_id        text,                                 -- GHL message id, Slack ts
  error              text
);

-- Replica of GHL messages, plus ours. SMS bodies kept; email bodies not.
create table messages (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id),
  contact_id           uuid not null references contacts(id),
  ghl_message_id       text,
  ghl_conversation_id  text,
  channel              text not null check (channel in ('sms','email')),
  direction            text not null check (direction in ('inbound','outbound')),
  body                 text,                               -- null for email
  subject              text,
  sent_by              text check (sent_by in ('engine','human','other')),
  send_id              uuid references sends(id),
  status               text,
  error                text,
  occurred_at          timestamptz not null,
  unique (company_id, ghl_message_id)
);
create index on messages (company_id, contact_id, occurred_at);

-- Where each poll left off. Durable, so an outage resumes instead of rescanning.
create table poll_cursors (
  company_id            uuid not null references companies(id),
  entity                text not null,                     -- contacts | appointments:<calendar_id> | conversations | opportunities
  cursor                text not null,
  last_polled_at        timestamptz,
  last_success_at       timestamptz,
  consecutive_failures  int not null default 0,
  primary key (company_id, entity)
);

create table slack_connections (
  company_id   uuid primary key references companies(id),
  team_id      text not null,
  bot_token    bytea not null,                             -- encrypted
  channels     jsonb not null default '{}',                -- {"closers":"C0123","managers":"C0456","ops":"C0789"}
  connected_by uuid references users(id),
  connected_at timestamptz not null default now()
);

-- D70. A conversation with the Slack bot: one row per thread (a DM's top level is the channel's 'dm' row, forgotten
-- after 30 quiet minutes). The thread's earlier questions and answers go back to the model so "and last month?" works;
-- the last 20 turns are kept. A slash command's own post is a thread too, so anyone can follow up under it.
create table bot_threads (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  channel     text not null,
  thread_ts   text not null,                               -- the thread's root ts; 'dm' for a DM's top level
  asked_by    text,                                        -- Slack user id of whoever started it
  messages    jsonb not null default '[]',                 -- [{role: user|bot, text, user?, kind?: answer|clarify|escalate, at}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, channel, thread_ts)
);

create table audit_log (
  id           bigserial primary key,
  company_id   uuid references companies(id),
  actor_id     uuid references users(id),
  action       text not null,                              -- binding.updated, workflow.enabled, command.reassign, ...
  target_type  text,
  target_id    text,
  before       jsonb,
  after        jsonb,
  at           timestamptz not null default now()
);
```

---

## 10. The workflow definition

Stored in `workflow_templates.definition` and `workflow_versions.definition`. This is what the
editor reads and writes, and what the engine executes.

```jsonc
{
  "schema": 1,
  "reentry": "once_per_appointment",
  "reentry_key": "{{appointment.starts_at}}",   // optional (D59): appended to the policy's key; a finished run does not block the same appointment at a new time
  "premise": { "check": "appointment_in_future", "of": "appointment" },   // always-on moot check

  "nodes": [
    { "id": "t1", "type": "trigger", "event": "appointment.booked",
      "match": { "eq": ["{{appointment.term.category}}", "closing"] } },

    { "id": "n1", "type": "wait",
      "rule": { "anchor": "appointment.starts_at", "offset": "day_of@08:00", "tz": "contact",
                "guard": { "min_lead": "2h", "fallback": "day_before@19:00" } } },

    { "id": "n2", "type": "send_sms",
      "template": "Hey {{contact.first_name}}, your call with {{appointment.closer.first_name}} is {{appointment.starts_at | relative:auto}}. Reply YES to confirm.",
      "validity": { "anchor": "before_event", "min_lead": "15m" },
      "on_stale": "skip" },

    { "id": "n3", "type": "wait", "rule": { "anchor": "now", "offset": "+4h" } },

    { "id": "n4", "type": "classify",
      "input": "{{reply.last_inbound.body}}",
      "state": "{{reply.last_outbound.body}}",
      "domain": "reply_intent", "threshold": 0.8, "into": "reply.intent" },

    { "id": "n5", "type": "branch", "on": "{{reply.intent}}" },

    { "id": "n6", "type": "set_tag", "tag": "confirmed" },
    { "id": "n7", "type": "update_appointment", "set": { "status": "cancelled" } },
    { "id": "n8", "type": "slack_post", "channel": "{{slack.channel.closers}}",
      "template": "{{contact.first_name}} cancelled {{appointment.starts_at | relative:auto}}." },
    { "id": "n9", "type": "send_sms", "template": "No problem — grab a new time here: {{calendar.closer_call.url}}" },
    { "id": "n10", "type": "set_tag", "tag": "needs-human-reply" },
    { "id": "n11", "type": "note",
      "template": "[engine] Couldn't classify reply (top: {{reply.top_guesses}}). Needs a human.\nOriginal: {{reply.last_inbound.body}}" },
    { "id": "n12", "type": "pause_runs", "scope": "contact" },

    { "id": "x1", "type": "exit", "reason": "confirmed" },
    { "id": "x2", "type": "exit", "reason": "cancelled" },
    { "id": "x3", "type": "exit", "reason": "reschedule_sent" },
    { "id": "x4", "type": "exit", "reason": "handed_to_human" }
  ],

  "edges": [
    { "from": "t1", "to": "n1" }, { "from": "n1", "to": "n2" }, { "from": "n2", "to": "n3" },
    { "from": "n3", "to": "n4" }, { "from": "n4", "to": "n5" },
    { "from": "n5", "to": "n6",  "when": { "eq": ["{{reply.intent}}", "confirmed"] } },
    { "from": "n5", "to": "n7",  "when": { "eq": ["{{reply.intent}}", "cancelled"] } },
    { "from": "n5", "to": "n9",  "when": { "eq": ["{{reply.intent}}", "reschedule_request"] } },
    { "from": "n5", "to": "n10", "else": true },
    { "from": "n6", "to": "x1" }, { "from": "n7", "to": "n8" }, { "from": "n8", "to": "x2" },
    { "from": "n9", "to": "x3" }, { "from": "n10", "to": "n11" }, { "from": "n11", "to": "n12" },
    { "from": "n12", "to": "x4" }
  ]
}
```

### Node types [decided — the instruction set]

| Type | Does | Needs |
|---|---|---|
| `trigger` | Starts a run on an event matching `match` | `event`, `match` |
| `wait` | Sets `next_run_at` from a rule (D14) | `rule` |
| `send_sms` / `send_email` | Renders template at send time, sends via adapter, writes `sends` | `template`, `validity`, `on_stale` |
| `slack_post` | Posts to a bound channel | `channel`, `template` |
| `classify` | Jev `choice` over a vocabulary domain, with threshold → `unclear` | `input`, `state`, `domain`, `threshold`, `into` |
| `branch` | Evaluates outgoing edges' `when` in order; first true wins; `else` edge last | — |
| `check` | Two-way branch: continue if predicate true, else exit with reason | `when`, `else_exit` |
| `set_tag` / `remove_tag` | GHL tag via API; mirrors to `contacts.tags` | `tag` |
| `note` | Internal note on the GHL contact | `template` |
| `update_appointment` | Read-then-write PUT (never omits `appointmentStatus`) | `set` |
| `update_opportunity` | Our row, and GHL stage if bound | `set` |
| `set_var` | Writes into `run.context.vars` | `key`, `value` |
| `start_workflow` | Terminal: ends this run, emits an event the target's trigger matches | `workflow`, `with` |
| `pause_runs` | Pauses other active runs for this contact (human took over) | `scope` |
| `exit` | Ends the run with a reason | `reason` |

### Predicate tree (conditions)
`{"eq":[a,b]}` · `{"neq":[a,b]}` · `{"gt":[a,b]}` · `{"gte":[a,b]}` · `{"lt":[a,b]}` ·
`{"lte":[a,b]}` · `{"in":[a,[…]]}` · `{"exists":"path"}` · `{"and":[…]}` · `{"or":[…]}` ·
`{"not":p}`. Operands are literals or `{{path}}` references into run context. No eval, no code.

### Template filters
`relative:auto|minutes|hours` (D5a rounding, throws on non-positive) · `date:fmt` · `tz:contact`
· `upper` · `first_name`. The engine refuses a template that references an unknown path at save.

### Run context (what `{{…}}` resolves against)
`contact.*` · `appointment.*` (incl. `.closer.*`, `.term.*`) · `opportunity.*` · `company.*` ·
`calendar.<key>.*` · `slack.channel.<role>` · `reply.*` · `event.*` (the trigger) · `vars.*` ·
bindings by key, with secrets masked in logs.

### Manifest (extracted on save)
```json
{ "bindings": [
    { "key": "crm.location_id",      "kind": "id",      "required": true },
    { "key": "calendar.closer_call", "kind": "id",      "required": true,  "resolves": "calendars" },
    { "key": "slack.channel.closers","kind": "channel", "required": false }
] }
```
`resolves` tells the install form to render a live dropdown from the company's GHL (with the
"create it for me" button) instead of a text box.

---

## 11. Adapters

Interfaces the engine calls. GHL is the first implementation of the CRM three; Jev of the
classifier; Slack of the notifier. Nothing in `runs` or the node executors imports a vendor.

```ts
interface CrmRead {
  contactsChangedSince(c: Company, cursor: string): Promise<{ contacts: ContactSnapshot[]; cursor: string }>;
  appointmentsInWindow(c: Company, calendarId: string, from: Date, to: Date): Promise<AppointmentSnapshot[]>;
  inboundSince(c: Company, cursor: string): Promise<{ messages: MessageSnapshot[]; cursor: string }>;
  opportunitiesSince(c: Company, cursor: string): Promise<{ opportunities: OppSnapshot[]; cursor: string }>;
  getAppointment(c: Company, id: string): Promise<AppointmentSnapshot>;        // premise checks read live
  getContact(c: Company, id: string): Promise<ContactSnapshot>;
  listCalendars(c: Company): Promise<CalendarSnapshot[]>;                        // install dropdown
  listUsers(c: Company): Promise<UserSnapshot[]>;                                // auto-create unclaimed users
}

interface CrmWrite {
  createContact(c: Company, input: NewContact): Promise<{ id: string }>;
  addTag(c: Company, contactId: string, tag: string): Promise<void>;
  removeTag(c: Company, contactId: string, tag: string): Promise<void>;
  addNote(c: Company, contactId: string, body: string): Promise<void>;
  createAppointment(c: Company, input: NewAppointment): Promise<{ id: string }>;
  updateAppointment(c: Company, id: string, full: AppointmentSnapshot): Promise<void>;  // full record, always
  createCalendar(c: Company, input: NewCalendar): Promise<{ id: string }>;
}

interface Sender {
  sendSms(c: Company, contactId: string, body: string, idem: string): Promise<SendResult>;
  sendEmail(c: Company, contactId: string, subject: string, html: string, idem: string): Promise<SendResult>;
  deliveryStatus(c: Company, externalId: string): Promise<{ status: string; error?: string }>;
}

interface Classifier {
  choice(state: string, input: string, options: string[], threshold: number):
    Promise<{ value: string; confidence: number; distribution: Record<string, number>; unclear: boolean }>;
}

interface Notifier {
  post(c: Company, channelRole: string, text: string): Promise<{ ts: string }>;
}
```

`SendResult = { externalId: string; accepted: boolean; error?: string }`. The GHL `Sender` uses
`POST /conversations/messages` with `contactId`; `updateAppointment` reads first and re-sends
every field because of the status-clobber behavior in `../ghl/02-api-facts.md`.

---

## 12. Row-level security

Every table with `company_id` gets the same policy. The app sets the company per request; the
operator role is an explicit, logged bypass.

```sql
alter table contacts enable row level security;
create policy tenant_isolation on contacts
  for all
  using (
    company_id = current_setting('app.company_id', true)::uuid
    or current_setting('app.role', true) = 'operator'
  );
-- repeat for every tenant table; a migration test asserts the policy exists on each one.
```

Per request: `select set_config('app.company_id', $1, true), set_config('app.role', $2, true)`.
A forgotten `where company_id = …` returns zero rows. Operator reads write a row to `audit_log`
with `action = 'operator.read'` and the table touched, so cross-tenant access is a record, not
a habit.

---

## 13. Lifecycle rules the engine runs (not stored, but defined here)

| Rule | Fires on | Does |
|---|---|---|
| Opportunity open | `appointment.booked` (or per `opp_opens_on`) with no open opportunity on the contact | insert `opportunities`, emit `opportunity.opened` |
| Opportunity won | `payment.received` (or per `opp_won_on`) | `status='won'`, emit `opportunity.won`. This is a **deal**. |
| Opportunity lost | closer marks lost, or no events in `opp_inactive_days` | `status='lost'`, emit `opportunity.lost` |
| Paid in full | sum of succeeded payments ≥ `contract_value` | emit `payment.paid_in_full` |
| Appointment type | `appointment.booked` | `appointment_term` from `calendars.appointment_term` |
| Contact attributes | `intake` insert | merge into `contacts.attributes` |
| Unclaimed user | poll sees unknown `assignedUserId` | insert `users` with `claimed_at = null` from `listUsers` |

---

## 14. Not modeled yet, on purpose

- Multiple offers per company (second company record is the answer for now).
- Attribute reclassification across a type change (bookkeeping is in place; the tool is later).
- Email bodies, recordings, transcripts (pointers only; D1).
- The command center's action catalog (D10 — a table of named actions comes with the first one).
- Slack bot identity for closers (users table has the slot; the bot is later).
