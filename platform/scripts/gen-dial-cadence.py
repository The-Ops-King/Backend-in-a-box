# D352: generates src/templates/dial-cadence.json and dial-cadence-exits.json (python3 scripts/gen-dial-cadence.py src/templates)
import json, sys
F = lambda b: "{{crm.field_contact_%s}}" % b
FV = lambda b: "{{contact.fields.%s | default:}}" % b
TODAY = "{{now | date_company:yyyy-MM-dd}}"
CALLS = {"earliest": "08:00", "latest": "20:00", "after_latest": "next_day", "skip_days": [7], "skip_holidays": "us_federal"}
def win(a, b): return {"earliest": a, "latest": b, "after_latest": "same_day", "skip_days": [7], "skip_holidays": "us_federal"}
MORN, AFT, EVE = win("08:00", "11:00"), win("12:00", "16:00"), win("16:00", "20:00")
nodes, edges = [], []
def N(**n): nodes.append(n); return n["id"]
def E(a, b, **k): edges.append({"from": a, "to": b, **k})
LEFT = {"or": [{"in": [FV("cycle_status"), ["Removed", "Completed", "Long-term Nurture"]]}, {"eq": ["{{contact.has_upcoming_call}}", True]}]}

# ---- entry
N(id="t_leap", type="trigger", event="tag.added", match={"eq": ["{{event.tag}}", "leap-buyer"]})
N(id="t_enroll", type="trigger", event="operator.enrolled")
N(id="t_noshow", type="trigger", event="appointment.status_changed", match={"and": [{"eq": ["{{event.status.to}}", "noshow"]}, {"eq": ["{{appointment.term.category}}", "closing"]}]})
N(id="c_once", type="check", title="Not already in a cycle (a repeat purchase never restarts one)", when={"not": {"in": [FV("cycle_status"), ["Active", "Paused"]]}}, else_exit="already in a cycle")
E("t_leap", "c_once"); E("t_enroll", "c_once")
N(id="b_resets", type="branch", title="How many no-show resets already?")
N(id="v_r1", type="set_var", key="resets", value="1"); N(id="v_r2", type="set_var", key="resets", value="2")
N(id="n_cap", type="update_contact", title="Third no-show: long-term nurture, out of the lists", fields=[{"id": F("cycle_status"), "value": "Long-term Nurture"}], clear=[F("next_call_due")])
N(id="g_cap", type="tags", add="long-term-nurture")
N(id="x_cap", type="exit", reason="no-show cap: long-term nurture")
E("t_noshow", "b_resets")
E("b_resets", "n_cap", when={"gt": [FV("no_show_resets"), 1]}, label="2 resets already"); E("n_cap", "g_cap"); E("g_cap", "x_cap")
E("b_resets", "v_r2", when={"gt": [FV("no_show_resets"), 0]}, label="1 reset"); E("b_resets", "v_r1", **{"else": True, "label": "first no-show"})
N(id="n_resets", type="update_contact", title="Count the no-show reset", fields=[{"id": F("no_show_resets"), "value": "{{vars.resets}}"}])
E("v_r1", "n_resets"); E("v_r2", "n_resets")
N(id="c_booked", type="check", title="No upcoming booking (booking always overrides dialing)", when={"eq": ["{{contact.has_upcoming_call}}", False]}, else_exit="booked")
N(id="c_dq", type="check", title="Not marked dq-financial", when={"not": {"has": ["{{contact.tags}}", "dq-financial"]}}, else_exit="dq-financial")
E("c_once", "c_booked"); E("n_resets", "c_booked"); E("c_booked", "c_dq")
N(id="v_start", type="set_var", key="start", when={"exists": "event.cycle_start"}, value="{{event.cycle_start}}", else_value="{{now}}", title="The cycle starts now (or when the operator's backfill says it did)")
N(id="v_last", type="set_var", key="last", value="{{vars.start}}", title="No call made yet in this cycle")
N(id="n_enter", type="update_contact", title="Enter the cycle: status, reason, start, attempts 0",
  fields=[{"id": F("cycle_status"), "value": "Active"}, {"id": F("entry_reason"), "value": "{{vars.reason}}"}, {"id": F("cycle_start"), "value": TODAY}, {"id": F("attempt_count"), "value": "{{event.attempts_done | default:0}}"}],
  clear=[F("next_call_due"), F("last_outcome"), F("paused_at")])
N(id="v_reason", type="set_var", key="reason", value="{{event._type}}", pick={"appointment.status_changed": "No-show", "operator.enrolled": "{{event.entry_reason | default:Never booked}}"}, else_value="Never booked", title="Entry reason: no-show, what the operator said, else never booked")
E("c_dq", "v_reason"); E("v_reason", "v_start"); E("v_start", "v_last"); E("v_last", "n_enter")

# ---- the 12 attempts: (waits before it is due)
sched = {
 1: [("now", "+0m", CALLS)],
 2: [("vars.start", "+30m", CALLS), ("vars.last", "+25m", CALLS)],
 3: [("vars.start", "+2h", CALLS), ("vars.last", "+90m", CALLS)],
 4: [("vars.start", "+1d", MORN), ("vars.last", "+12h", MORN)],
 5: [("vars.start", "+2d", AFT), ("vars.last", "+12h", AFT)],
 6: [("vars.start", "+3d", EVE), ("vars.last", "+12h", EVE)],
 7: [("vars.start", "+4d", MORN), ("vars.last", "+12h", MORN)],
}
weekly = [MORN, AFT, EVE, MORN, AFT]
for i, n in enumerate(range(8, 13)): sched[n] = [("vars.last", "+7d", weekly[i])]
N(id="b_start", type="branch", title="Which call do they start at?")
E("n_enter", "b_start")
prev = None
for n in range(1, 13):
  waits = sched[n]
  for k, (anchor, off, rule) in enumerate(waits):
    wid = "w%d%s" % (n, "abc"[k])
    if k == 0:
      if n == 1: E("b_start", wid, **{"else": True, "label": "call #1"})
      else: E("b_start", wid, when={"eq": ["{{event.start_at | default:1}}", n]}, label="backfilled: call #%d" % n)
    N(id=wid, type="wait", title="Call #%d not before %s %s" % (n, {"now": "entry", "vars.start": "cycle start", "vars.last": "the last call"}[anchor], off), rule={"anchor": anchor, "offset": off, "tz": "contact", **rule})
    if prev: E(prev, wid)
    prev = wid
  sid, pid = "s%d" % n, "p%d" % n
  N(id=sid, type="branch", title="Still in the cycle for call #%d?" % n)
  N(id="x_left%d" % n, type="exit", reason="left the cycle")
  N(id=pid, type="wait", title="Paused: resume 24 hours later", rule={"anchor": "now", "offset": "+24h", "tz": "contact", **CALLS})
  N(id="r%d" % n, type="update_contact", title="Resume after the pause", fields=[{"id": F("cycle_status"), "value": "Active"}], clear=[F("paused_at")])
  E(prev, sid)
  E(sid, "x_left%d" % n, when=LEFT, label="booked or out")
  E(sid, pid, when={"eq": [FV("cycle_status"), "Paused"]}, label="paused")
  E(pid, "r%d" % n)
  did = "due%d" % n
  N(id=did, type="update_contact", title="Call #%d is due: Next Call Due = today" % n, fields=[{"id": F("next_call_due"), "value": TODAY}])
  E(sid, did, **{"else": True, "label": "active"}); E("r%d" % n, did)
  eid, aid, e2 = "dial%d" % n, "late%d" % n, "dial%db" % n
  N(id=eid, type="wait_for_event", title="Wait for Nick's dial #%d (4 hours)" % n, event="call.logged", match={"eq": ["{{data.direction}}", "outbound"]}, until={"anchor": "now", "offset": "+4h", "tz": "contact"}, into="d%d" % n, respect_send_window=False)
  N(id=aid, type="slack_post", title="Not dialed 4 hours after it was due: tell the team", channel="{{slack.channel.alerts}}", fallback_channel="{{slack.channel.bookings}}",
    **{"as": {"name": "Dial cadence", "icon": ":telephone_receiver:"}}, template="Call #%d to <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:someone}}> has been due 4 hours and not dialed. They stay on the list until it is." % n)
  # Tyler, 2026-11-19: no auto-advance and no attempt that did not happen: not dialed, they stay due (Speed to lead shows them waiting) until Nick dials
  N(id=e2, type="wait_for_event", title="Still due: wait for the dial", event="call.logged", match={"eq": ["{{data.direction}}", "outbound"]}, into="d%d" % n, respect_send_window=False)
  N(id="cl%d" % n, type="check", title="Still in the cycle before saying it is late", when={"not": LEFT}, else_exit="left the cycle")
  E(did, eid); E(eid, "rec%d" % n, label="event"); E(eid, "cl%d" % n, label="until"); E("cl%d" % n, aid); E(aid, e2); E(e2, "rec%d" % n, label="event")
  N(id="rec%d" % n, type="update_contact", title="Dial #%d made: count it, off the lists until the next one is due" % n,
    fields=[{"id": F("attempt_count"), "value": str(n)}, {"id": F("last_call_at"), "value": TODAY}], clear=[F("next_call_due")])
  lid = "last%d" % n
  N(id=lid, type="set_var", key="last", value="{{now}}", title="Call #%d done (dialed or missed)" % n)
  E("rec%d" % n, lid)
  prev = lid
N(id="n_done", type="update_contact", title="12 calls made: completed", fields=[{"id": F("cycle_status"), "value": "Completed"}], clear=[F("next_call_due")])
N(id="g_done", type="tags", add="long-term-nurture"); N(id="x_done", type="exit", reason="completed: long-term nurture")
E(prev, "n_done"); E("n_done", "g_done"); E("g_done", "x_done")

cad = {"slug": "dial-cadence", "name": "Dial cadence", "category": "setter", "stage": "nurture", "sort": 40, "origin": "default", "optional": True,
 "description": "Calls for people who have not booked: Leap buyers who never booked (or anyone the operator enrolls) and closing-call no-shows. Each gets up to 12 calls: one at once, 30 minutes and 2 hours later, one a day for four days in rotating windows, then one a week for five weeks, only 8am to 8pm in their time and never on a Sunday or US federal holiday. The engine sets Next Call Due when a call is due (the smart lists show it) and counts every dial from GHL; a call not dialed 4 hours after it was due is said to the team once and stays due (no attempt is counted that was not made); booking, a purchase or dq-financial takes them out (Dial cadence: exits). A no-show restarts the cycle, at most twice; the third goes to long-term nurture. Nothing is sent to the person.",
 "definition": {"schema": 1, "reentry": "once_per_contact", "reentry_key": "{{appointment.id | default:cycle}}", "premise": {"check": "contact_exists"}, "nodes": nodes, "edges": edges}}

# ---- exits
xn, xe = [], []
def XN(**n): xn.append(n)
def XE(a, b, **k): xe.append({"from": a, "to": b, **k})
XN(id="t_booked", type="trigger", event="appointment.booked"); XN(id="t_paid", type="trigger", event="payment.received"); XN(id="t_dq", type="trigger", event="tag.added", match={"eq": ["{{event.tag}}", "dq-financial"]})
XN(id="v_b", type="set_var", key="outcome", value="Booked"); XN(id="v_p", type="set_var", key="outcome", value=""); XN(id="v_d", type="set_var", key="outcome", value="Financial DQ")
XE("t_booked", "v_b"); XE("t_paid", "v_p"); XE("t_dq", "v_d")
XN(id="c_in", type="check", title="In a dial cycle now", when={"in": [FV("cycle_status"), ["Active", "Paused"]]}, else_exit="not in a cycle")
for v in ("v_b", "v_p", "v_d"): XE(v, "c_in")
XN(id="n_out", type="update_contact", title="Out of the cycle and off every list", fields=[{"id": F("cycle_status"), "value": "Removed"}, {"id": F("last_outcome"), "value": "{{vars.outcome}}"}], clear=[F("next_call_due")])
XN(id="x_out", type="exit", reason="removed"); XE("c_in", "n_out"); XE("n_out", "x_out")
exits = {"slug": "dial-cadence-exits", "name": "Dial cadence: exits", "category": "setter", "stage": "nurture", "sort": 41, "origin": "default", "optional": True,
 "description": "Takes a person out of their dial cycle the moment they book, pay, or are tagged dq-financial: Cycle Status Removed, Last Outcome said, Next Call Due cleared so they leave every smart list. Someone not in a cycle is left alone.",
 "definition": {"schema": 1, "reentry": "always", "premise": {"check": "contact_exists"}, "nodes": xn, "edges": xe}}
out = sys.argv[1]
json.dump(cad, open(out + "/dial-cadence.json", "w"), indent=2, ensure_ascii=False); json.dump(exits, open(out + "/dial-cadence-exits.json", "w"), indent=2, ensure_ascii=False)
print(len(nodes), "nodes", len(edges), "edges;", len(xn), "exit nodes")
