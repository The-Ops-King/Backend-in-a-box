-- Engine schema. Extracted from engine/02-data-model.md §1–§9 and executed clean on
-- Postgres 16 on 2026-10-06: 28 tables, 72 foreign keys. Regenerate from the doc; don't
-- hand-edit this file and the doc separately.

create table companies (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text not null unique,
  timezone          text not null,                      -- IANA, e.g. America/Phoenix
  send_window_start time not null default '08:00',
  send_window_end   time not null default '20:00',
  quiet_allow_transactional boolean not null default false,   -- dark hours: true lets transactional sends ("you're booked") through; human-sounding sends always wait
  sms_enabled       boolean not null default true,      -- false when the sub-account has no number; SMS nodes skip
  mode              text not null default 'shadow' check (mode in ('shadow','test','live')),  -- the ladder (D52): shadow runs everyone and writes nothing; test = sys-test contacts and test-domain emails only, everything real for them; live = everyone
  status            text not null default 'active'
                    check (status in ('onboarding','active','hosted','archived')),
  archived_at       timestamptz,
  purge_after_months int not null default 12,
  -- opportunity lifecycle rules (per-company settings, Tyler: "depends on workflow and settings")
  reached_seconds   int not null default 60,            -- a connected dial at least this long counts as the lead being reached (speed to lead)
  contract_value_default numeric(12,2),                 -- the program price; a new opportunity's contract_value until a closer sets one
  opp_opens_on      text not null default 'first_booking'
                    check (opp_opens_on in ('lead_created','first_booking','pipeline_entry')),
  opp_won_on        text not null default 'first_payment'
                    check (opp_won_on in ('first_payment','closer_marks','paid_in_full')),
  opp_lost_on       text not null default 'closer_marks_or_inactive'
                    check (opp_lost_on in ('closer_marks','closer_marks_or_inactive')),
  opp_inactive_days int not null default 90,
  reply_retention_days int not null default 7,       -- D38: an inbound reply's row lives this long (the wait-for-reply step needs hours); the event stays
  sends_retention_days int not null default 30,      -- D38: the engine's own sends, with their words, live this long
  created_at        timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),            -- null = operator (Tyler)
  email         text not null,
  name          text not null,
  role          text not null
                check (role in ('operator','owner','manager','closer','setter','staff')),   -- staff: on the CRM roster, takes no calls; only closers get the end-of-day link (D34)
  ghl_user_id   text,
  slack_user_id text,
  report_token  text unique,        -- the closer's standing end-of-day link (D34)
  claimed_at    timestamptz,       -- null = auto-created from GHL roster, not yet logged in
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, email),
  unique (company_id, ghl_user_id)
);

create table contacts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  ghl_contact_id  text,
  first_name      text,
  last_name       text,
  timezone        text,                                   -- IANA or null
  timezone_source text check (timezone_source in ('ghl','booking','phone','company_default')),
  tags            text[] not null default '{}',           -- replica of GHL tags
  ghl_fields      jsonb not null default '{}',            -- human-entered GHL custom fields (replica)
  attributes      jsonb not null default '{}',            -- DERIVED: merge of intake rows, ours
  merged_into     uuid references contacts(id),           -- set when this record was folded into another
  ghl_updated_at  timestamptz,
  ghl_added_at    timestamptz,                            -- when the CRM first saw them: the lead's arrival for every dated question
  assigned_ghl_user_id text,                              -- the contact's owner in the CRM (assignedTo)
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
  unique (company_id, kind, value)
);

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
  ('call_outcome','follow_up','Follow-up',3),        ('call_outcome','deposit','Deposit',4),
  ('call_outcome','closed','Closed',5),              ('call_outcome','lost','Lost',6),
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

create table calendars (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  source           text not null default 'ghl' check (source in ('ghl','calendly')),   -- where this calendar lives
  external_id      text not null,                                                      -- GHL calendar id or Calendly event type uuid
  name             text not null,
  appointment_term uuid not null references company_terms(id),   -- which kind of call this calendar books
  default_user_id  uuid references users(id),
  self_booked      boolean,                                       -- every booking on this calendar is self-booked (true) / setter-booked (false); null = unknown
  config               jsonb not null default '{}',   -- D24: {booking: self|setter|question, questions: {setter: 'Who set this call?', phone: '...', <attribute>: '<question text>'}}
  booking_url      text,                                          -- public scheduling link, used by {{calendar.*.url}}
  active           boolean not null default true,
  unique (company_id, source, external_id)
);

-- One pursuit of a sale. Holds N appointments. Ends won (= a deal) or lost.
create table opportunities (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  contact_id          uuid references contacts(id),                   -- null for a run about the company or a person (schedule triggers, eod.filed)
  user_id             uuid references users(id),                      -- the person a run is about (a closer's end-of-day), when there is one
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

-- A CRM pipeline card. One pursuit (opportunity) can sit on several boards at once (Hair: a setter card and a
-- closer card), so cards are their own rows and the opportunity stays one per pursuit.
create table pipeline_cards (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  opportunity_id      uuid not null references opportunities(id),
  contact_id          uuid references contacts(id),                   -- null for a run about the company or a person (schedule triggers, eod.filed)
  user_id             uuid references users(id),                      -- the person a run is about (a closer's end-of-day), when there is one
  ghl_opportunity_id  text,                              -- null in shadow (never written to the CRM)
  ghl_pipeline_id     text not null,
  ghl_stage_id        text not null,
  name                text not null,
  assigned_user_id    uuid references users(id),          -- the card's owner in the CRM (the closer), when the engine set it
  status              text not null default 'open',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, ghl_opportunity_id)
);
create index on pipeline_cards (company_id, contact_id, ghl_pipeline_id);

create table appointments (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id),
  contact_id           uuid not null references contacts(id),
  opportunity_id       uuid references opportunities(id),
  source               text not null default 'ghl' check (source in ('ghl','calendly','test')),   -- test: staged by the simulation harness, never at a booking source
  external_id          text not null,                                -- GHL appointment id or Calendly scheduled event uuid
  calendar_id          uuid references calendars(id),
  appointment_term     uuid not null references company_terms(id),  -- from the calendar at booking; overridable
  assigned_user_id     uuid references users(id),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  self_booked          boolean,
  set_by               text,                                       -- setter's name when the booking source carries it
  answers              jsonb not null default '{}',                -- booking-form answers by the name the calendar's config gave them (D24)
  reschedule_url       text,                                       -- per-booking self-service links (Calendly); null for GHL calendars
  cancel_url           text,
  tracking             jsonb not null default '{}',                -- utm_* etc. as the booking source reported them
  cancelled_by         text,                                       -- who cancelled (name) and why, when the source says
  cancel_reason        text,
  booked_at            timestamptz not null,
  -- replica of the booking source's state (GHL vocabulary; Calendly active/canceled maps onto it)
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

-- The ledger. A payment is a fact even when nobody matched it: contact_id is null and link_status is 'unlinked'
-- until the identity ladder (member id → email → phone) or a person links it. Refunds are negative rows.
create table payments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  contact_id       uuid references contacts(id),
  opportunity_id   uuid references opportunities(id),
  provider         text not null default 'whop',
  whop_payment_id  text not null,                        -- provider payment id (pay_…); refunds carry the refund id
  amount           numeric(12,2) not null,
  currency         text not null default 'USD',
  installment_no   int,
  status           text not null check (status in ('succeeded','failed','refunded')),
  kind             text check (kind in ('deposit','installment','balance','paid_in_full','refund','chargeback','failed')),   -- derived from the ledger, never from the provider
  customer_email   text,                                 -- identity as the checkout reported it, kept even when unlinked
  customer_phone   text,
  whop_member_id   text,                                 -- stable buyer id; a later payment with the same id resolves through an earlier linked one
  link_status      text not null default 'linked' check (link_status in ('linked','unlinked')),
  linked_by        text,                                 -- email | phone | member_id | manual | heal
  paid_at          timestamptz not null,
  raw              jsonb not null default '{}',          -- the small, structured part of the webhook
  unique (company_id, provider, whop_payment_id)
);
create index on payments (company_id, link_status);

-- CRM custom-object records the engine writes (payment, sales_call, …), keyed by what identifies them to us, so an
-- update never depends on the CRM's lagging search index.
create table crm_records (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  object_key     text not null,                          -- custom_objects.payment
  record_key     text not null,                          -- our key: the provider payment id, the Calendly event uuid, …
  ghl_record_id  text,                                   -- null in shadow
  contact_id     uuid references contacts(id),
  properties     jsonb not null default '{}',            -- last written
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, object_key, record_key)
);

-- Idempotency for inbound webhooks: the provider's delivery id, so a retried delivery is a no-op before any parsing.
-- Call recordings (D22). One row per recording the provider reports, linked to a person or not, same shape as the
-- payments ledger: identity is a ladder (invitee email → invitee name → the closer's calendar around the start time),
-- a miss is an unlinked row the team fixes by hand. The transcript lives here, never in a run's context.
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
  url              text,                                 -- provider page (login)
  share_url        text,                                 -- the link a person clicks
  recorded_by_email text,
  recorded_by_name text,
  invitees         jsonb not null default '[]',          -- [{name, email, is_external}]
  transcript       jsonb,                                -- [{speaker, email, text, timestamp}]
  summary          text,                                 -- provider's own summary, markdown
  analysis         jsonb not null default '{}',          -- what the analyze nodes produced, keyed by the node's `into`
  link_status      text not null default 'unlinked' check (link_status in ('linked','unlinked')),
  linked_by        text,                                 -- email | name | calendar | manual
  unlinked_reason  text,
  raw              jsonb not null default '{}',
  received_at      timestamptz not null default now(),
  unique (company_id, provider, external_id)
);
create index on recordings (company_id, link_status);

create index on recordings (company_id, contact_id);

create table webhook_deliveries (
  company_id   uuid not null references companies(id),
  provider     text not null,
  delivery_id  text not null,
  received_at  timestamptz not null default now(),
  primary key (company_id, provider, delivery_id)
);
create index on payments (company_id, opportunity_id);

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
  ('payment.received','payment'), ('payment.failed','payment'), ('payment.paid_in_full','payment'), ('payment.refunded','payment'), ('payment.unlinked','payment'), ('payment.linked','payment'),
  ('recording.received','call'), ('recording.unlinked','call'), ('recording.linked','call'), ('call.analyzed','call'), ('call.logged','call'),
  ('agreement.sent','agreement'), ('agreement.signed','agreement'),
  ('tag.added','crm'), ('tag.removed','crm'), ('stage.changed','crm'),
  ('schedule','clock'), ('eod.filed','report'), ('slack.reaction','slack'),
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
  source          text not null check (source in ('form','ghl_poll','whop','fathom','zapier','engine','disposition','command_center','user','test')),
  data            jsonb not null default '{}'
);
create index on events (company_id, contact_id, occurred_at);
create index on events (company_id, event_type, occurred_at);
create index on events (company_id, opportunity_id);

create table forms (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  purpose          text not null check (purpose in ('intake','disposition','eod')),
  appointment_term uuid references company_terms(id),  -- required when purpose = disposition
  name             text not null,
  version          int not null default 1,
  fields           jsonb not null,    -- [{key,label,type,required,enum_values,min,max,help}]; purpose eod: EodField[] (src/engine/eod-form.ts)
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

-- Operator-owned library. No company_id.
create table workflow_templates (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text,
  category     text not null,              -- speed_to_lead, reminders, no_show, reactivation, payments, replies
  stage        text,                       -- where on the journey (src/engine/stages.ts: lead, booking, pre_call, call, post_call, closing, payments, reactivation, team, engine)
  sort         int not null default 0,     -- order within the stage
  origin       text,                       -- 'spec': built from Tyler's own description, Zap or CRM workflow; 'default': a starting point the engine shipped, to review or replace
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
  stage             text,                                 -- copied from the template at install; a custom workflow sets its own
  sort              int not null default 0,
  origin            text,                                 -- copied from the template; a workflow built in the chat for one company is 'spec'
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

create table runs (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  workflow_id         uuid not null references workflows(id),
  workflow_version    int not null,                        -- pinned at start; edits never move a live run
  contact_id          uuid references contacts(id),                   -- null for a run about the company or a person (schedule triggers, eod.filed)
  user_id             uuid references users(id),                      -- the person a run is about (a closer's end-of-day), when there is one
  opportunity_id      uuid references opportunities(id),
  appointment_id      uuid references appointments(id),
  trigger_id          uuid references workflow_triggers(id) on delete set null,   -- which trigger started it; history survives a trigger node being removed
  triggered_by_event  bigint references events(id),
  status              text not null default 'active'
                      check (status in ('active','waiting','paused','completed','exited','failed')),
  current_node        text,
  next_run_at         timestamptz,                         -- THE clock. Null when not waiting.
  wake_on_reply       boolean not null default false,       -- true only while parked on wait_for_reply; an inbound message wakes these and nothing else
  context             jsonb not null default '{}',         -- resolved vars, last reply, etc.
  exit_reason         text,
  reentry_key         text not null,                       -- computed per policy; unique prevents double runs
  pending_events      jsonb not null default '[]',          -- triggers that arrived while this run held the once-per key; replayed if the run stops at a gate (D30)
  claimed_at          timestamptz,                         -- scheduler lease
  claimed_by          text,
  born_in             text not null default 'live' check (born_in in ('shadow','test','live')),   -- the company's mode when the run started; runs not born live are cleared at Go live (D51)
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  unique (workflow_id, reentry_key)
);
create index on runs (status, next_run_at) where status in ('active','waiting');
create index on runs (company_id, contact_id);

-- One row per node execution. This is the flow view and the debugger.
create table run_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references runs(id),
  node_id     text not null,
  node_type   text not null,
  status      text not null check (status in ('ok','skipped','stale','failed','waiting')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  result      jsonb not null default '{}',
  error       text
);
create index on run_steps (run_id, started_at);

-- The idempotent send ledger. A retry can't double-send because the key already exists.
create table sends (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id),
  run_id             uuid references runs(id),
  run_step_id        uuid references run_steps(id),
  contact_id         uuid references contacts(id),           -- null for a message to the team (alerts)
  channel            text not null check (channel in ('sms','email','slack','webhook')),
  idempotency_key    text not null unique,                 -- run_id:node_id:attempt-group, or notify:<channel>:<uuid>
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

alter table appointments add constraint appointments_disposition_fk foreign key (disposition_id) references form_submissions(id) on delete set null;

-- Daily rollups (D29). One row per company, local day, dimension and metric; counts and sums only. Rates are computed
-- when read (numerator / denominator), never stored: an average of averages is wrong. Recomputed from the ledger, so a
-- row is a cache of facts the engine already holds, not a second source of truth.
create table rollups_daily (
  company_id    uuid not null references companies(id) on delete cascade,   -- derived: goes with the company
  day           date not null,                              -- the company's local day
  dimension     text not null check (dimension in ('total','setter','closer')),
  dimension_id  text not null default '',                   -- users.id for setter/closer, '' for total, 'unknown' when the person is not on the roster
  metric        text not null,
  value         numeric not null default 0,
  computed_at   timestamptz not null default now(),
  primary key (company_id, day, dimension, dimension_id, metric)
);

-- When each company wants its wrap-ups. Times are the company's local clock. Nothing here is a constant in code.
-- Every wrap-up that was generated, scheduled or on demand, so it can be read without Slack. (Named wrapups, not reports: the
-- production Postgres is shared with other apps and already had a "reports" table; see ownsOrAbsent in migrate.ts.)
create table wrapups (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  kind          text not null check (kind in ('daily','weekly','monthly')),
  period_start  date not null,
  period_end    date not null,                              -- inclusive
  generated_at  timestamptz not null default now(),
  on_demand     boolean not null default false,
  body          text not null,                              -- the Slack text
  numbers       jsonb not null default '{}',                -- the totals behind it
  send_id       uuid references sends(id) on delete set null
);
create index on wrapups (company_id, generated_at);

-- Agreements (D30): every document the CRM's Documents & Contracts sent to a contact, mirrored by the poll. One row per
-- document; `signed_at` is set once when the signer completes it, and that transition is the `agreement.signed` event.
create table agreements (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  contact_id     uuid references contacts(id),
  external_id    text not null,                              -- the CRM document id
  name           text,
  status         text not null,                              -- sent | viewed | completed | … as the CRM reports it
  sent_at        timestamptz not null,
  signed_at      timestamptz,
  sent_by        text,                                       -- 'engine' when a send_document step created it, else null
  raw            jsonb not null default '{}',
  updated_at     timestamptz not null default now(),
  unique (company_id, external_id)
);
create index on agreements (company_id, contact_id);

-- D33. The engine tells the operator the minute something fails, and sweeps every connection on a schedule.
-- One open row per (company, key); announced once, repeated hourly in the thread while open, "resolved" in the thread + ✅ when it clears.
create table alerts (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid references companies(id) on delete cascade,   -- null: the engine itself
  key                text not null,                                     -- step:<workflow>:<node> | poll:<entity> | health:<check>[:<item>] | engine:<what>
  level              text not null check (level in ('error','warning')),
  source             text not null check (source in ('step','poll','health','engine')),
  text               text not null,
  detail             jsonb not null default '{}',
  href               text,                                              -- dashboard path to the thing that failed
  first_seen         timestamptz not null default now(),
  last_seen          timestamptz not null default now(),
  announced_at       timestamptz,                                       -- last time it was said (first post or hourly repeat)
  announce_count     int not null default 0,
  slack_channel      text,
  slack_ts           text,                                              -- the first post; repeats and the resolution go in its thread
  resolved_at        timestamptz,
  resolved_announced boolean not null default false
);
create unique index alerts_open_one on alerts (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), key) where resolved_at is null;
create index on alerts (company_id, resolved_at, last_seen);

-- The hourly sweep, per company: its own automation with its own clock, channel, face, and list of checks.
create table health_checks (
  company_id     uuid primary key references companies(id) on delete cascade,
  channel        text,                                   -- Slack channel id for sweep alerts, copied from the health_check step each run; null → the alerts channel
  as_name        text,
  as_icon        text,
  last_run_at    timestamptz,
  last_result    jsonb not null default '[]'             -- [{check, item, ok, level, text}] from the last sweep
);

-- D34. The closer's end-of-day report: one per closer per day; the DM that asked for it, what the engine prefilled, what they answered, what they corrected.
-- A Slack post a step asked to remember (slack_post.tag), so a later run can reply in its thread or react to it (eod-filed ticks the reminder DM).
create table slack_posts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  tag        text not null,
  channel    text not null,
  ts         text not null,
  run_id     uuid references runs(id) on delete set null,
  posted_at  timestamptz not null default now(),
  unique (company_id, tag)
);

create table eod_reports (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  day          date not null,
  prefill      jsonb,
  answers      jsonb,
  changes      jsonb not null default '[]',
  reminded_at  timestamptz,
  dm_channel   text,
  dm_ts        text,
  submitted_at timestamptz,
  unique (company_id, user_id, day)
);

