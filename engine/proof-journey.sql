drop table if exists events, event_types cascade;
create table event_types (name text primary key, category text not null);
insert into event_types values
 ('lead.created','lead'),('intake.recorded','lead'),
 ('appointment.booked','appointment'),('appointment.outcome','appointment'),
 ('reply.classified','message'),('call.held','call'),('payment.received','payment');
create table events (
  id bigserial primary key, client_id text not null, contact_id text not null,
  event_type text not null references event_types(name),
  occurred_at timestamptz not null, source text not null, data jsonb not null default '{}');
create index on events (client_id, contact_id, occurred_at);
create index on events (client_id, event_type, occurred_at);

with c as (select g as n, 'c'||g as id, 1+(g%5) as hl, (g*37)%100 as r from generate_series(1,200) g),
j as (select *, r<80 as booked,
  case when r<80 and (r*13)%100 < 55+hl*5 then 'confirmed' when r<80 and (r*13)%100>=92 then 'cancelled' when r<80 then 'none' end as reply,
  timestamp '2026-09-01' + (n||' hours')::interval as t0 from c)
insert into events (client_id,contact_id,event_type,occurred_at,source,data)
select 'syh', id, 'lead.created', t0, 'form', '{"referral":"ig"}' from j
union all select 'syh', id, 'intake.recorded', t0, 'form', jsonb_build_object('hair_loss_level',hl) from j
union all select 'syh', id, 'appointment.booked', t0+interval '10 min', 'ghl_poll', jsonb_build_object('self_booked',n%3=0) from j where booked
union all select 'syh', id, 'reply.classified', t0+interval '3 hours', 'engine', jsonb_build_object('intent',reply,'confidence',0.9) from j where booked and reply<>'none'
union all select 'syh', id, 'appointment.outcome', t0+interval '2 days', 'disposition',
  jsonb_build_object('outcome', case when reply='cancelled' then 'cancelled' when reply='confirmed' and (n*7)%100<75 then 'showed' when reply='none' and (n*7)%100<40 then 'showed' else 'noshow' end) from j where booked
union all select 'syh', id, 'call.held', t0+interval '2 days', 'disposition', '{"type":"discovery"}' from j
  where booked and reply<>'cancelled' and ((reply='confirmed' and (n*7)%100<75) or (reply='none' and (n*7)%100<40))
union all select 'syh', id, 'call.held', t0+interval '5 days', 'disposition', '{"type":"closing"}' from j where booked and reply='confirmed' and (n*7)%100<45
union all select 'syh', id, 'payment.received', t0+interval '6 days', 'whop', jsonb_build_object('plan',(array['pif','2-pay','4-pay'])[1+n%3],'amount',2500) from j where booked and reply='confirmed' and (n*7)%100<25;

\echo
\echo '== A. how many confirmed? =='
select count(*) as confirmed from events where client_id='syh' and event_type='reply.classified' and data->>'intent'='confirmed';
\echo
\echo '== B. the funnel, one query =='
select count(*) filter (where event_type='lead.created') as leads,
  count(*) filter (where event_type='appointment.booked') as booked,
  count(*) filter (where event_type='reply.classified' and data->>'intent'='confirmed') as confirmed,
  count(*) filter (where event_type='appointment.outcome' and data->>'outcome'='showed') as showed,
  count(*) filter (where event_type='call.held' and data->>'type'='closing') as closing_calls,
  count(*) filter (where event_type='payment.received') as closed
from events where client_id='syh';
\echo
\echo '== C. does confirming predict showing? =='
select coalesce(r.data->>'intent','no reply') as reply, count(*) as booked,
  count(*) filter (where o.data->>'outcome'='showed') as showed,
  round(100.0*count(*) filter (where o.data->>'outcome'='showed')/count(*))||'%' as show_rate
from events b left join events r on r.contact_id=b.contact_id and r.event_type='reply.classified'
join events o on o.contact_id=b.contact_id and o.event_type='appointment.outcome'
where b.client_id='syh' and b.event_type='appointment.booked' group by 1 order by 3 desc;
\echo
\echo '== D. one contact as a sentence =='
select contact_id, string_agg(event_type||coalesce(' ('||coalesce(data->>'intent',data->>'outcome',data->>'type',data->>'plan')||')',''), ' -> ' order by occurred_at) as journey
from events where contact_id='c3' group by 1;
\echo
\echo '== E. hair loss level -> confirm rate -> show rate =='
select (i.data->>'hair_loss_level')::int as hair_loss, count(*) as booked,
  round(100.0*count(*) filter (where r.data->>'intent'='confirmed')/count(*))||'%' as confirm_rate,
  round(100.0*count(*) filter (where o.data->>'outcome'='showed')/count(*))||'%' as show_rate
from events b join events i on i.contact_id=b.contact_id and i.event_type='intake.recorded'
left join events r on r.contact_id=b.contact_id and r.event_type='reply.classified'
join events o on o.contact_id=b.contact_id and o.event_type='appointment.outcome'
where b.client_id='syh' and b.event_type='appointment.booked' group by 1 order by 1;
\echo
\echo '== F. median days booking -> close =='
select round(percentile_cont(0.5) within group (order by extract(epoch from p.occurred_at-b.occurred_at)/86400)::numeric,1) as median_days
from events b join events p on p.contact_id=b.contact_id and p.event_type='payment.received' where b.event_type='appointment.booked';
\echo
\echo '== G. where is everyone right now? (derived, not stored) =='
select stage, count(*) from (select distinct on (contact_id) contact_id,
  case event_type when 'payment.received' then 'closed' when 'call.held' then 'in calls'
    when 'appointment.outcome' then 'post-call: '||(data->>'outcome') when 'reply.classified' then 'replied: '||(data->>'intent')
    when 'appointment.booked' then 'booked, silent' else 'lead' end as stage
  from events where client_id='syh' order by contact_id, occurred_at desc) s group by 1 order by 2 desc;
\echo
\echo '== H. vocabulary is enforced: a typo must FAIL =='
insert into events (client_id,contact_id,event_type,occurred_at,source) values ('x','c1','appointment.confirmd',now(),'test');
