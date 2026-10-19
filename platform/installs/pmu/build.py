# Builds PMU's own workflow copies from the shipped templates (one board, PMU's GHL keys). Run: python3 -I build.py; save each
# JSON with POST /api/admin/workflows/definition (dryRun first). Hair's copies are never touched.
import json, sys, copy
import os
HERE=os.path.dirname(os.path.abspath(__file__))
T=os.path.join(HERE,'../../src/templates/')
OUT=HERE+'/'
def load(slug): return json.load(open(T+slug+'.json'))['definition']
def node(d, i): return next(n for n in d['nodes'] if n['id']==i)
def drop(d, i):
    """remove node i, joining its single in-edges to its single out-edge"""
    ins=[e for e in d['edges'] if e['to']==i]; outs=[e for e in d['edges'] if e['from']==i]
    assert len(outs)==1, (i, outs)
    for e in ins: e['to']=outs[0]['to']
    d['edges']=[e for e in d['edges'] if e['from']!=i]
    d['nodes']=[n for n in d['nodes'] if n['id']!=i]
def after(d, prev, new):
    """insert node new after prev (prev must have one out-edge)"""
    outs=[e for e in d['edges'] if e['from']==prev]; assert len(outs)==1, (prev, outs)
    idx=[n['id'] for n in d['nodes']].index(prev)
    d['nodes'].insert(idx+1, new)
    d['edges'].append({'from':new['id'],'to':outs[0]['to']}); outs[0]['to']=new['id']
CLOSER='{{crm.pipeline_closer}}'
out={}
PMU_OBJ=['price','think_about_it','spouse_partner','timing','finances','already_working_with_someone','tried_similar_before','no_time_to_implement','skeptical_it_works','needs_more_info','shopping_around','financing_declined','too_early_in_business','went_dark','not_qualified','none']

# New lead: a lead is someone with a phone or a VSL tag; the card starts on Beauty Moguls
d=load('new-lead')
n1=node(d,'n1'); n1['when']={'or':[{'exists':'contact.phone'},{'has':['{{contact.tags}}','vsl a']},{'has':['{{contact.tags}}','vsl b']}]}
n1['else_exit']='no_phone_or_vsl'; n1['title']='A lead has a phone number or a VSL tag (vsl a, vsl b)'
n2=node(d,'n2'); n2.update(pipeline=CLOSER, stage='{{crm.stage_closer_new_lead}}'); n2.pop('fields',None)
out['new-lead']=(d,"PMU: one board. The card starts on Beauty Moguls at New Lead; a lead has a phone or a VSL tag (vsl a / vsl b); no stage-entered field")

# Call booked: one card. -- Direct / -- Setter on a booking, Rescheduled on a reschedule (the name it had stays); no UTM fields
d=load('call-booked')
drop(d,'u1'); drop(d,'s3'); drop(d,'b4')
RESCHED={'eq':['{{event._type}}','appointment.rescheduled']}
# D105: a reschedule moves the card only off the pre-call stages (cards from before the engine sit anywhere); one in Follow Up,
# Lost, Purchase, Signed Contract or DQ is left alone
PRE_CALL=['{{crm.stage_closer_new_lead}}','{{crm.stage_closer_scheduled}}','{{crm.stage_closer_unresponsive}}','{{crm.stage_closer_confirmed}}','{{crm.stage_closer_no_show}}','{{crm.stage_closer_cancelled}}','{{crm.stage_closer_rescheduled}}']
# One card, one fork, after the setter / self paths rejoin (a fork inside a fork reads worse and the chart drew none of it):
# each path only says how the call was booked; then a new booking names the card and puts it on Booked Call, a
# reschedule moves it to Rescheduled only off a pre-call stage and keeps its name (D105)
drop(d,'s4'); drop(d,'b5')
after(d,'s2b',{'id':'s_suffix','type':'set_var','key':'card_suffix','value':'Direct'})
after(d,'b3',{'id':'b_suffix','type':'set_var','key':'card_suffix','value':'Setter'})
k3_in=[e for e in d['edges'] if e['to']=='k3']
assert sorted(e['from'] for e in k3_in)==['b6','s5'], k3_in
for e in k3_in: e['to']='f_card'
SETTER_OWNER=[{'id':'{{crm.field_opportunity_setter_owner}}','value':'{{appointment.set_by | default:}}'}]
CARD={'type':'pipeline_card','pipeline':CLOSER,'name':'{{contact.name}} -- {{vars.card_suffix}}','assign_to':'{{appointment.closer.ghl_user_id | default:}}','fields':SETTER_OWNER}
idx=[n['id'] for n in d['nodes']].index('k3')
d['nodes'][idx:idx]=[{'id':'f_card','type':'branch','title':'A new booking or a reschedule?'},
  {**CARD,'id':'c_new','title':'Card → Booked Call, named -- Setter / -- Direct','stage':'{{crm.stage_closer_scheduled}}'},
  {**CARD,'id':'c_rs','title':'Card → Rescheduled, if it is before the call (its name stays)','stage':'{{crm.stage_closer_rescheduled}}','keep_name':True,'from_stages':PRE_CALL}]
d['edges']+=[{'from':'f_card','to':'c_rs','label':'a reschedule','when':RESCHED},{'from':'f_card','to':'c_new','label':'a new booking','else':True},{'from':'c_new','to':'k3'},{'from':'c_rs','to':'k3'}]
node(d,'n1')['fields'][0]['value']='{{appointment.starts_at | date_company:MM-dd-yyyy HH:mm}}'   # PMU's own format on Appointment Start Time (e.g. 10-15-2026 15:00)
k4=node(d,'k4'); k4['properties']['call_type']='{{vars.call_type}}'; k4['properties']['closer']='{{appointment.closer.first_name | default: | lower}}'
after(d,'k3',{'id':'v_type','type':'set_var','title':'Closing or Demo: the call type the calendar books','key':'call_type','value':'{{appointment.term.name}}','pick':{'Demo call':'demo'},'else_value':'closing'})
# what belongs to one side sits on that side: the video task under a new booking, the old slot's Sales Call under a
# reschedule (every reschedule carries the slot it left, poll.ts), so neither is a sometimes-step any more
d['edges']=[e for e in d['edges'] if e['from'] not in ('f_card','k3','k5','v_type') and e['to']!='k3']
d['edges']+=[{'from':'f_card','to':'c_rs','label':'a reschedule','when':RESCHED},{'from':'f_card','to':'c_new','label':'a new booking','else':True},
  {'from':'c_new','to':'k3'},{'from':'k3','to':'v_type'},{'from':'c_rs','to':'k5'},{'from':'k5','to':'v_type'},{'from':'v_type','to':'k4'}]
node(d,'k3').pop('only_if'); node(d,'k5').pop('only_if')
node(d,'k5')['title']='The Sales Call for the old time: logged as rescheduled'
node(d,'b3')['title']='The setter goes on the contact'
ids=[n['id'] for n in d['nodes']]; k5=d['nodes'].pop(ids.index('k5')); d['nodes'].insert([n['id'] for n in d['nodes']].index('k3')+1, k5)
out['call-booked']=(d,"PMU: one board, one card fork after the setter / self paths: a new booking puts the card on Booked Call named -- Direct or -- Setter; a reschedule moves it to Rescheduled only off a pre-call stage and keeps its name; the Sales Call says Closing or Demo; no UTM fields; Appointment Start Time in PMU's format (10-15-2026 15:00)")

# Call cancelled: the one card → Canceled Call
d=load('call-cancelled'); drop(d,'n1')
out['call-cancelled']=(d,"PMU: one board. No setter card; the card moves to Canceled Call")

# Call outcome: no setter card; a no-show → No Show; PMU's disposition keys
d=load('call-outcome'); drop(d,'gn1'); drop(d,'sc1')
gn2=node(d,'gn2'); gn2['stage']='{{crm.stage_closer_no_show}}'; gn2['title']='Card → No Show (move only: they can rebook)'
# D119: the disposition is the template's, in PMU's own keys (its sales_call.dispositions: a deposit is Deposit, never closed won);
# a deposit's card moves to Deposit once the board has one bound (crm.stage_closer_deposit), skipped until then
out['call-outcome']=(d,"PMU: one board. No setter card; a no-show moves the card to No Show; a deposit is its own disposition (Deposit, from PMU's sales_call.dispositions) and its card goes to Deposit once the board has that stage (D119)")

# Call recorded: no setter card to mark showed; the closer as PMU's dropdown key; only answers PMU's dropdowns have
d=load('call-recorded'); drop(d,'o3')
r1=node(d,'r1')['properties']
r1['closer']='{{recording.closer.first_name | default: | lower}}'
r1['disposition']='{{vars.outcome.disposition | oneof:closed_won,follow_up,lost,dq | default:}}'
r1['objection_primary']='{{vars.notes.primary_objection | oneof:'+','.join(PMU_OBJ)+' | default:}}'
node(d,'n1')['template']=('CURRENT SITUATION: {{vars.notes.prospect_situation | default:—}}\n\n'
  'PAINS: {{vars.notes.pain | join:" " | default:—}}\n\n'
  'GOALS: {{vars.notes.desire | join:" " | default:—}}\n\n'
  'OBJECTIONS: {{vars.notes.objections | each:"{{item.objection}}" | join:", " | default:None}}\n\n'
  'Fathom recording: {{recording.share_url | default:—}}')
s1=node(d,'s1')
s1['template']=('*Name:* <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:Unknown}}>{{vars.recording_line}}\n'
  '{{vars.appt_line}}\n'
  '*Closer:* {{recording.closer.name | default:unknown}} · {{vars.convo.total_min | default:?}} min{{vars.parts_line}}\n'
  '*Outcome:* {{vars.outcome.disposition | words | default:unclear}}\n\n'
  '*Current situation:* {{vars.notes.prospect_situation | default:—}}\n'
  '*Pains:* {{vars.notes.pain | join:" " | default:—}}\n'
  '*Goals:* {{vars.notes.desire | join:" " | default:—}}\n'
  '*Objections:* {{vars.notes.objections | each:"{{item.objection}}" | join:", " | default:None}}\n'
  '*Next step:* {{vars.notes.next_step | default:—}} {{vars.notes.next_step_date | date_company:ccc LLL d | prefix:by}}')
s1['as']['icon']=[':bomb:',':clapper:',':fire:',':snowman:',':airplane:',':fire_engine:',':tent:',':volcano:',':beach_with_umbrella:',':dragon_face:',':eagle:',':panda_face:',':wolf:',':lion_face:',':brain:',':dizzy:',':boom:',':mirror_ball:',':ninja:',':gorilla:']
out['call-recorded']=(d,"PMU: one board. No setter card to mark showed; the closer, disposition and objection in PMU's own dropdown keys; the GHL note is Tyler's four sections (current situation, pains, goals, objections) and the Fathom link, the Slack post says the same with his emoji, the scorecard only in the thread")

# Deal closed: the one card → Signed Contract, won; PMU's disposition key
d=load('deal-closed'); drop(d,'p2')
out['deal-closed']=(d,"PMU: one board. The card moves to Signed Contract, won; no setter card")

# Payment recorded: PMU's Cash object; the card → Purchase
d=load('payment-recorded')
n4=node(d,'n4'); n4['object']='custom_objects.cash'
n4['properties']['paid_date']='{{event.paid_at | date_company:yyyy-MM-dd}}'
n4['properties']['link_status']='{{contact.ghl_contact_id | default: | then:linked}}'
a3=node(d,'a3'); a3['stage']='{{crm.stage_closer_purchase}}'; a3['title']='Card → Purchase (paid, agreement sent)'
out['payment-recorded']=(d,"PMU: payments go on PMU's Cash object; the card moves to Purchase when the agreement goes out")

# Pre-call sequence: the card follows the confirmation
d=load('pre-call-sequence')
# D148: Carly's Strategy Call (call type Follow-up call) is a follow-up or a reschedule: no pre-call reminders for it
for t in ('t1','t2'): node(d,t)['match']={'and':[{'eq':['{{appointment.term.category}}','closing']},{'neq':['{{appointment.term.name}}','Follow-up call']}]}
after(d,'n_conf',{'id':'k_conf','type':'pipeline_card','title':'Card → Call Confirmed','pipeline':CLOSER,'stage':'{{crm.stage_closer_confirmed}}','if_missing':'skip','pick':'latest'})
after(d,'n_unc',{'id':'k_unc','type':'pipeline_card','title':'No reply in 4 hours: card → Unresponsive - Call Unconfirmed','pipeline':CLOSER,'stage':'{{crm.stage_closer_unresponsive}}','if_missing':'skip','pick':'latest'})
out['pre-call-sequence']=(d,"PMU: the card follows the confirmation: Call Confirmed when they confirm, Unresponsive - Call Unconfirmed when there is no reply in 4 hours")

# Card moved: PMU's no-show stage is No Show
d=load('card-moved')
e=next(e for e in d['edges'] if e['from']=='b1' and e['to']=='o_noshow')
e['when']['and'][-1]={'and':[{'eq':['{{event.pipeline}}','closer']},{'eq':['{{event.to_stage}}','{{crm.stage_closer_no_show | default:}}']}]}
out['card-moved']=(d,"PMU: a card moved by hand into No Show after the call started files a no-show")

for slug,(d,note) in out.items():
    json.dump({'workflow':slug,'note':note,'definition':d}, open(OUT+slug+'.json','w'), indent=1); open(OUT+slug+'.json','a').write('\n')
    print(slug, len(d['nodes']), 'nodes')
