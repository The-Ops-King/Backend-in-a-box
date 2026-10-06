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
  booking_url      text,                                          -- public scheduling link, used by {{calendar.*.url}}
  active           boolean not null default true,
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

-- A CRM pipeline card. One pursuit (opportunity) can sit on several boards at once (Hair: a setter card and a
-- closer card), so cards are their own rows and the opportunity stays one per pursuit.
create table pipeline_cards (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id),
  opportunity_id      uuid not null references opportunities(id),
  contact_id          uuid not null references contacts(id),
  ghl_opportunity_id  text,                              -- null in shadow (never written to the CRM)
  ghl_pipeline_id     text not null,
  ghl_stage_id        text not null,
  name                text not null,
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
  source               text not null default 'ghl' check (source in ('ghl','calendly')),
  external_id          text not null,                                -- GHL appointment id or Calendly scheduled event uuid
  calendar_id          uuid references calendars(id),
  appointment_term     uuid not null references company_terms(id),  -- from the calendar at booking; overridable
  assigned_user_id     uuid references users(id),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  self_booked          boolean,
  set_by               text,                                       -- setter's name when the booking source carries it
  reschedule_url       text,                                       -- per-booking self-service links (Calendly); null for GHL calendars
  cancel_url           text,
  tracking             jsonb not null default '{}',                -- utm_* etc. as the booking source reported them
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
  ('tag.added','crm'), ('tag.removed','crm'), ('stage.changed','crm'),
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
  source          text not null check (source in ('form','ghl_poll','whop','engine','disposition','command_center','user')),
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
  context             jsonb not null default '{}',         -- resolved vars, last reply, etc.
  exit_reason         text,
  reentry_key         text not null,                       -- computed per policy; unique prevents double runs
  claimed_at          timestamptz,                         -- scheduler lease
  claimed_by          text,
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
