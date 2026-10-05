#!/usr/bin/env bash
# Sales backend — data layer builder.
# Idempotent: checks before creating, safe to re-run.
#
#   export GHL_PIT='pit-...'         # PIT created INSIDE the target sub-account
#   export GHL_LOC='...'             # target location id
#   ./build-backend.sh
#
# Builds: contact fields · Sales Call object + fields + association · pipelines
#         users · calendar group + calendars · tags · custom values
# Does NOT build: workflows, forms, smart lists (no API exists — see 03-manual-steps.md)

set -uo pipefail
PIT="${GHL_PIT:?set GHL_PIT}"; LOC="${GHL_LOC:?set GHL_LOC}"
BASE="https://services.leadconnectorhq.com"
CREATED=0; SKIPPED=0; FAILED=0

# curl only — Cloudflare rejects python urllib on this API (Error 1010)
api () { local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -sS -X "$m" -H "Authorization: Bearer $PIT" -H "Version: 2021-07-28" \
      -H "Content-Type: application/json" -H "Accept: application/json" "$BASE$p" -d "$d"
  else
    curl -sS -X "$m" -H "Authorization: Bearer $PIT" -H "Version: 2021-07-28" \
      -H "Accept: application/json" "$BASE$p"
  fi; }
jq_ () { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
$1" 2>/dev/null; }
ok ()   { CREATED=$((CREATED+1)); printf '  \033[32m+\033[0m %s\n' "$1"; }
skip () { SKIPPED=$((SKIPPED+1)); printf '  \033[90m=\033[0m %s\n' "$1"; }
err ()  { FAILED=$((FAILED+1));  printf '  \033[31m!\033[0m %s — %s\n' "$1" "${2:0:110}"; }
hdr ()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ─── 1. CONTACT FIELDS ────────────────────────────────────────────────────────
hdr "1. Contact fields"
EXIST=$(api GET "/locations/$LOC/customFields?model=contact" | jq_ "
print('|'.join(f['name'] for f in d.get('customFields',[])))")
FOLDER=$(api GET "/locations/$LOC/customFields?model=contact" | jq_ "
print(next((f['id'] for f in d.get('customFields',[]) if f.get('documentType')=='folder' and f['name']=='Core System'),''))")
if [ -z "$FOLDER" ]; then
  FOLDER=$(api POST "/locations/$LOC/customFields" \
    '{"name":"Core System","documentType":"folder","model":"contact","dataType":"TEXT"}' \
    | jq_ "print(d.get('customFieldFolder',{}).get('id',''))")
  [ -n "$FOLDER" ] && ok "folder Core System" || err "folder Core System" "create failed"
else skip "folder Core System"; fi

D=SINGLE_OPTIONS
while IFS='|' read -r NAME TYPE OPTS; do
  [ -z "${NAME:-}" ] && continue
  case "$EXIST" in *"$NAME"*) skip "$NAME"; continue;; esac
  if [ -n "$OPTS" ]; then
    OJ=$(python3 -c "import json,sys;print(json.dumps(sys.argv[1].split(',')))" "$OPTS")
    BODY="{\"name\":\"$NAME\",\"dataType\":\"$TYPE\",\"model\":\"contact\",\"parentId\":\"$FOLDER\",\"options\":$OJ}"
  else
    BODY="{\"name\":\"$NAME\",\"dataType\":\"$TYPE\",\"model\":\"contact\",\"parentId\":\"$FOLDER\"}"
  fi
  R=$(api POST "/locations/$LOC/customFields" "$BODY")
  K=$(echo "$R" | jq_ "print(d['customField']['fieldKey'])")
  [ -n "$K" ] && ok "$NAME → $K" || err "$NAME" "$R"
  sleep 0.35
done <<'FIELDS'
* lead_source|SINGLE_OPTIONS|instagram,youtube,facebook,tiktok,linkedin,email,sms,podcast,webinar,referral,partner,direct,manual
* entry_type|SINGLE_OPTIONS|application,opt_in,quiz,giveaway,dm,ads_form,manual,booked_direct
* utm_medium|SINGLE_OPTIONS|ad,post,story,bio,dm,reel,comment,description,newsletter,broadcast,shoutout,organic
* utm_campaign|TEXT|
* utm_content|TEXT|
* referral_partner|TEXT|
* entry_url|LARGE_TEXT|
* setter_owner|TEXT|
* pain_fit|SINGLE_OPTIONS|yes,no
* timing_fit|SINGLE_OPTIONS|now,soon,later
* financial_fit|SINGLE_OPTIONS|qualified,needs_financing,not_yet,no
* routing|SINGLE_OPTIONS|direct_to_closer,setter_first,nurture,disqualify
* appointment_state|SINGLE_OPTIONS|none,booked,showed,no_show,cancelled
* agreement_signed_at|DATE|
* first_payment_at|DATE|
* lead_arrival|SINGLE_OPTIONS|business_hours,after_hours
* first_call_attempt_at|DATE|
* first_call_duration|NUMERICAL|
* speed_to_lead_alerted_at|DATE|
* lead_state|SINGLE_OPTIONS|new,working,booked,active_client,cold,nurture_only,unreachable,disqualified
* reactivation_reason|SINGLE_OPTIONS|no_show,cancelled,booked_no_contact,never_booked,webinar_no_show,webinar_attended_no_book,lost,lost_timing
* last_touch_at|DATE|
* next_call_at|DATE|
* next_message_at|DATE|
* touch_count|NUMERICAL|
* reactivation_cycle|NUMERICAL|
* payment_status|SINGLE_OPTIONS|paid_in_full,active,failed,cancelled
* total_collected|MONETORY|
* last_payment_date|DATE|
* failed_payment_count|NUMERICAL|
* whop_membership_id|TEXT|
* client_since|DATE|
FIELDS

# ─── 2. SALES CALL OBJECT ─────────────────────────────────────────────────────
hdr "2. Sales Call object"
OK_KEY="custom_objects.sales_call"
HAVE=$(api GET "/objects/?locationId=$LOC" | jq_ "
print('yes' if any(o.get('key')=='$OK_KEY' for o in d.get('objects',[])) else '')")
if [ -z "$HAVE" ]; then
  R=$(api POST "/objects/" "{\"labels\":{\"singular\":\"Sales Call\",\"plural\":\"Sales Calls\"},
   \"key\":\"$OK_KEY\",\"description\":\"One record per closer call, created at disposition.\",
   \"locationId\":\"$LOC\",
   \"primaryDisplayPropertyDetails\":{\"key\":\"$OK_KEY.name\",\"name\":\"Call Name\",\"dataType\":\"TEXT\"}}")
  echo "$R" | grep -q '"id"' && ok "object Sales Call (PERMANENT — cannot be deleted)" || err "object Sales Call" "$R"
  sleep 1
else skip "object Sales Call"; fi

SF=$(api GET "/custom-fields/object-key/$OK_KEY?locationId=$LOC" | jq_ "
print(next((f['id'] for f in d.get('folders',[]) if f.get('name')=='Core System'),''))")
if [ -z "$SF" ]; then
  SF=$(api POST "/custom-fields/folder" "{\"objectKey\":\"$OK_KEY\",\"name\":\"Core System\",\"locationId\":\"$LOC\"}" \
    | jq_ "print(d.get('id') or d.get('folder',{}).get('id',''))")
  [ -n "$SF" ] && ok "object folder Core System" || err "object folder" "create failed"
fi
SEXIST=$(api GET "/custom-fields/object-key/$OK_KEY?locationId=$LOC" | jq_ "
print('|'.join(f.get('fieldKey','') for f in d.get('fields',[])))")

while IFS='|' read -r NAME TYPE OPTS; do
  [ -z "${NAME:-}" ] && continue
  SLUG=$(echo "$NAME" | sed 's/^\* //; s/[^a-z0-9_]/_/g')
  case "$SEXIST" in *"$OK_KEY.$SLUG"*) skip "$NAME"; continue;; esac
  # object fields need options as {key,label} objects — unlike contact fields
  if [ -n "$OPTS" ]; then
    OJ=$(python3 -c "import json,sys;print(json.dumps([{'key':o,'label':o} for o in sys.argv[1].split(',')]))" "$OPTS")
    BODY="{\"locationId\":\"$LOC\",\"name\":\"$NAME\",\"dataType\":\"$TYPE\",\"objectKey\":\"$OK_KEY\",\"parentId\":\"$SF\",\"fieldKey\":\"$OK_KEY.$SLUG\",\"options\":$OJ}"
  else
    BODY="{\"locationId\":\"$LOC\",\"name\":\"$NAME\",\"dataType\":\"$TYPE\",\"objectKey\":\"$OK_KEY\",\"parentId\":\"$SF\",\"fieldKey\":\"$OK_KEY.$SLUG\"}"
  fi
  R=$(api POST "/custom-fields/" "$BODY")
  echo "$R" | grep -q '"fieldKey"' && ok "$NAME" || err "$NAME" "$R"
  sleep 0.35
done <<'SCF'
* closer|TEXT|
* setter|TEXT|
* appointment_at|DATE|
* appointment_id|TEXT|
* call_type|SINGLE_OPTIONS|discovery,closing,follow_up
* attendance|SINGLE_OPTIONS|showed,no_show,cancelled,rescheduled
* call_outcome|SINGLE_OPTIONS|won,lost,deposit,follow_up,call_delayed,nurture,dq
* dq_reason|SINGLE_OPTIONS|no_money,not_decision_maker,wrong_fit,no_real_problem,bad_contact_info
* dq_source|SINGLE_OPTIONS|setter,closer
* cash_collected|MONETORY|
* contract_value|MONETORY|
* payment_terms|SINGLE_OPTIONS|pif,2_pay,3_pay,financing,other
* loss_reason|SINGLE_OPTIONS|price,timing,spouse_partner,not_a_fit,went_elsewhere,ghosted,other
* next_step|TEXT|
* next_step_date|DATE|
* fathom_link|TEXT|
* disposition_complete|CHECKBOX|complete
* call_notes|LARGE_TEXT|
SCF

HAVE=$(api GET "/associations/?locationId=$LOC&limit=50&skip=0" | jq_ "
print('yes' if any(a.get('key')=='contact_sales_calls' for a in d.get('associations',[])) else '')")
if [ -z "$HAVE" ]; then
  R=$(api POST "/associations/" "{\"locationId\":\"$LOC\",\"key\":\"contact_sales_calls\",
   \"firstObjectLabel\":\"Contact\",\"firstObjectKey\":\"contact\",
   \"secondObjectLabel\":\"Sales Calls\",\"secondObjectKey\":\"$OK_KEY\"}")
  echo "$R" | grep -q '"id"' && ok "association contact → Sales Calls" || err "association" "$R"
else skip "association contact → Sales Calls"; fi

# ─── 3. PIPELINES ─────────────────────────────────────────────────────────────
hdr "3. Pipelines"
PEXIST=$(api GET "/opportunities/pipelines?locationId=$LOC" | jq_ "
print('|'.join(p['name'] for p in d.get('pipelines',[])))")
mkpipe () {
  case "$PEXIST" in *"$1"*) skip "$1"; return;; esac
  local JS; JS=$(python3 -c "
import json,sys
print(json.dumps([{'name':s,'position':i,'showInFunnel':True,'showInPieChart':True}
  for i,s in enumerate(sys.argv[1].split(','))]))" "$2")
  R=$(api POST "/opportunities/pipelines" "{\"locationId\":\"$LOC\",\"name\":\"$1\",\"stages\":$JS,\"showInFunnel\":true,\"showInPieChart\":true}")
  echo "$R" | grep -q '"id"' && ok "$1" || err "$1" "$R"; sleep 0.5; }
mkpipe "Setter Pipeline" "New Lead,Contacted,Qualified,Booked,Disqualified"
mkpipe "Closer Pipeline" "Booked,Showed,No Show,Follow Up,Closed Won,Closed Lost"

# ─── 4. USERS ─────────────────────────────────────────────────────────────────
hdr "4. Users"
CO=$(api GET "/locations/$LOC" | jq_ "print(d['location']['companyId'])")
UEXIST=$(api GET "/users/?locationId=$LOC" | jq_ "print('|'.join(u['email'] for u in d.get('users',[])))")
mkuser () {
  case "$UEXIST" in *"$3"*) skip "$3"; return;; esac
  R=$(api POST "/users/" "{\"companyId\":\"$CO\",\"locationIds\":[\"$LOC\"],
   \"firstName\":\"$1\",\"lastName\":\"$2\",\"email\":\"$3\",\"type\":\"account\",\"role\":\"user\",
   \"permissions\":{\"campaignsEnabled\":false,\"contactsEnabled\":true,\"workflowsEnabled\":false,
   \"opportunitiesEnabled\":true,\"appointmentsEnabled\":true,\"conversationsEnabled\":true,
   \"dashboardStatsEnabled\":true,\"settingsEnabled\":false,\"assignedDataOnly\":false}}")
  echo "$R" | grep -q '"id"' && ok "$1 $2 <$3>" || err "$3" "$R"; sleep 0.5; }
mkuser Closer One "${CLOSER1:-closer1@jtylerray.com}"
mkuser Closer Two "${CLOSER2:-closer2@jtylerray.com}"
mkuser Setter One "${SETTER1:-setter1@jtylerray.com}"

# ─── 5. CALENDARS ─────────────────────────────────────────────────────────────
hdr "5. Calendars"
GID=$(api GET "/calendars/groups?locationId=$LOC" | jq_ "
print(next((g['id'] for g in d.get('groups',[]) if g['name']=='Core System'),''))")
if [ -z "$GID" ]; then
  GID=$(api POST "/calendars/groups" "{\"locationId\":\"$LOC\",\"name\":\"Core System\",\"description\":\"Core sales calendars\",\"slug\":\"core-system\",\"isActive\":true}" \
    | jq_ "print((d.get('group') or d).get('id',''))")
  [ -n "$GID" ] && ok "calendar group Core System" || err "calendar group" "create failed"
fi
U=$(api GET "/users/?locationId=$LOC")
uid () { echo "$U" | jq_ "print(next((u['id'] for u in d['users'] if u['email']=='$1'),''))"; }
C1=$(uid "${CLOSER1:-closer1@jtylerray.com}"); C2=$(uid "${CLOSER2:-closer2@jtylerray.com}"); S1=$(uid "${SETTER1:-setter1@jtylerray.com}")
CEXIST=$(api GET "/calendars/?locationId=$LOC" | jq_ "print('|'.join(c['name'] for c in d.get('calendars',[])))")
mkcal () { # name slug members extra
  case "$CEXIST" in *"$1"*) skip "$1"; return;; esac
  R=$(api POST "/calendars/" "{\"locationId\":\"$LOC\",\"groupId\":\"$GID\",\"name\":\"$1\",\"description\":\"$1\",
   \"calendarType\":\"round_robin\",\"eventType\":\"RoundRobin_OptimizeForEqualDistribution\",
   \"slug\":\"$2\",\"slotDuration\":30,\"slotDurationUnit\":\"mins\",\"teamMembers\":$3,\"isActive\":true$4}")
  echo "$R" | grep -q '"id"' && ok "$1" || err "$1" "$R"; sleep 0.5; }
mkcal "Setter Discovery" "core-setter-discovery" "[{\"userId\":\"$S1\",\"priority\":0.5,\"isPrimary\":true}]" ""
mkcal "Closer Call (Setter Booked)" "core-closer-setter-booked" \
  "[{\"userId\":\"$C1\",\"priority\":0.5,\"isPrimary\":true},{\"userId\":\"$C2\",\"priority\":0.5,\"isPrimary\":false}]" ""
mkcal "Closer Call (Self Book)" "core-closer-self-book" \
  "[{\"userId\":\"$C1\",\"priority\":0.5,\"isPrimary\":true},{\"userId\":\"$C2\",\"priority\":0.5,\"isPrimary\":false}]" \
  ",\"shouldAssignContactToTeamMember\":true"

# ─── 6. TAGS ──────────────────────────────────────────────────────────────────
hdr "6. Tags"
TEXIST=$(api GET "/locations/$LOC/tags" | jq_ "print('|'.join(t['name'] for t in d.get('tags',[])))")
for T in sys-test sys-deposit-open \
  seq-stamp-attribution seq-create-opportunity seq-speed-to-lead seq-same-day-coverage \
  seq-log-first-call seq-mirror-state-tags seq-pre-call-reminders seq-ask-disposition \
  seq-no-show seq-cancelled-call seq-close-check \
  seq-payment-received seq-payment-failed seq-payment-cancelled \
  stat-appt-none stat-appt-booked stat-appt-showed stat-appt-no-show stat-appt-cancelled \
  stat-lead-new stat-lead-working stat-lead-booked stat-lead-active-client stat-lead-cold \
  stat-lead-nurture-only stat-lead-unreachable stat-lead-disqualified ; do
  case "$TEXIST" in *"$T"*) skip "$T"; continue;; esac
  api POST "/locations/$LOC/tags" "{\"name\":\"$T\"}" | grep -q '"tag"' && ok "$T" || err "$T" "rate limit or dupe"
  sleep 0.35
done

# ─── 7. CUSTOM VALUES ─────────────────────────────────────────────────────────
hdr "7. Custom values"
VEXIST=$(api GET "/locations/$LOC/customValues" | jq_ "print('|'.join(c['name'] for c in d.get('customValues',[])))")
while IFS='|' read -r N V; do
  [ -z "${N:-}" ] && continue
  case "$VEXIST" in *"$N"*) skip "$N"; continue;; esac
  api POST "/locations/$LOC/customValues" "{\"name\":\"$N\",\"value\":\"$V\"}" \
    | grep -q '"customValue"' && ok "$N" || err "$N" "create failed"
  sleep 0.35
done <<'CVALS'
slack_webhook_setters|TODO_PASTE_WEBHOOK
slack_webhook_closers|TODO_PASTE_WEBHOOK
slack_webhook_leadership|TODO_PASTE_WEBHOOK
slack_webhook_wins|TODO_PASTE_WEBHOOK
link_setter_discovery|TODO
link_closer_setter_booked|TODO
link_closer_self_book|TODO
link_disposition_form|TODO
link_prep_video|TODO
link_payment_update|TODO
copy_payment_failed_sms|TODO
copy_payment_failed_email|TODO
cfg_business_open|09:00
cfg_business_close|17:00
cfg_after_hours_cutoff_min|15
cfg_setter_daily_call_target|TODO
cfg_unreachable_attempts|TODO
cfg_working_to_cold_days|TODO
CVALS

printf '\n\033[1mDone.\033[0m created %d · skipped %d · failed %d\n' "$CREATED" "$SKIPPED" "$FAILED"
cat <<'NEXT'

Still yours, by hand (no API exists):
  · Timezone + business hours on the sub-account
  · 14 [CORE] workflows + 7 [STANDARD] shells — ALL BUILT OFF
  · 3 forms (intake, opt-in, disposition)
  · 10 smart lists
  · Agreement document
  · Calendar (Self Book): Allow Staff Selection OFF, Keep Same Appointment Owner, form first
NEXT
