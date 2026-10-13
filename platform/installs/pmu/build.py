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
PMU_DISP={'closed':'closed_won','deposit':'deposit','follow_up':'follow_up','lost':'lost','unqualified':'dq'}
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
def fork(card, fid, resched_id, extra=None):
    # the card's move is a fork the chart shows as one: a new booking names the card, a reschedule only moves it (its name stays)
    ins=[e for e in d['edges'] if e['to']==card]; outs=[e for e in d['edges'] if e['from']==card]
    assert len(ins)==1 and len(outs)==1, (card, ins, outs)
    nxt=outs[0]['to']; ins[0]['to']=fid
    idx=[n['id'] for n in d['nodes']].index(card)
    d['nodes'].insert(idx, {'id':fid,'type':'branch','title':'A new booking or a reschedule?'})
    r={'id':resched_id,'type':'pipeline_card','title':'Card → Rescheduled (its name stays)','pipeline':CLOSER,'stage':'{{crm.stage_closer_rescheduled}}','assign_to':'{{appointment.closer.ghl_user_id | default:}}'}
    if extra: r.update(extra)
    d['nodes'].insert(idx+2, r)
    d['edges']+= [{'from':fid,'to':resched_id,'label':'a reschedule','when':RESCHED},{'from':fid,'to':card,'label':'a new booking','else':True},{'from':resched_id,'to':nxt}]
s4=node(d,'s4'); s4['title']='Card → Booked Call, named -- Direct'
b5=node(d,'b5'); b5['name']='{{contact.name}} -- Setter'; b5['title']='Card → Booked Call, named -- Setter'
fork('s4','f_self','s4r')
fork('b5','f_set','b5r',{'fields':[{'id':'{{crm.field_opportunity_setter_owner}}','value':'{{appointment.set_by | default:}}'}]})
node(d,'n1')['fields'][0]['value']='{{appointment.starts_at | date_company:MM-dd-yyyy HH:mm}}'   # PMU's own format on Appointment Start Time (e.g. 10-15-2026 15:00)
k4=node(d,'k4'); k4['properties']['call_type']='{{vars.call_type}}'; k4['properties']['closer']='{{appointment.closer.first_name | default: | lower}}'
after(d,'k3',{'id':'v_type','type':'set_var','title':'Closing or Demo: the call type the calendar books','key':'call_type','value':'{{appointment.term.name}}','pick':{'Demo call':'demo'},'else_value':'closing'})
out['call-booked']=(d,"PMU: one board. The card moves to Booked Call named -- Direct or -- Setter; a reschedule moves it to Rescheduled and keeps its name; the Sales Call says Closing or Demo; no UTM fields; Appointment Start Time in PMU's format (10-15-2026 15:00)")

# Call cancelled: the one card → Canceled Call
d=load('call-cancelled'); drop(d,'n1')
out['call-cancelled']=(d,"PMU: one board. No setter card; the card moves to Canceled Call")

# Call outcome: no setter card; a no-show → No Show; PMU's disposition keys
d=load('call-outcome'); drop(d,'gn1'); drop(d,'sc1')
gn2=node(d,'gn2'); gn2['stage']='{{crm.stage_closer_no_show}}'; gn2['title']='Card → No Show (move only: they can rebook)'
v=node(d,'v_disp'); v['pick']=PMU_DISP
r1=node(d,'r1'); r1['properties']['disposition']='{{vars.disposition | oneof:closed_won,deposit,follow_up,lost,dq,no_offer | default:}}'
out['call-outcome']=(d,"PMU: one board. No setter card; a no-show moves the card to No Show; a deposit is its own disposition (Deposit), as PMU tracks it")

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

# EOD call filed: the closer's answer in PMU's disposition keys (a deposit is its own)
d=load('eod-call-filed'); node(d,'v_disp')['pick']=PMU_DISP
out['eod-call-filed']=(d,"PMU: the closer's answer goes on the Sales Call in PMU's disposition keys; a deposit is its own (Deposit)")

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
