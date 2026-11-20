# D354: generates src/templates/dial-cadence.json and dial-cadence-exits.json (python3 scripts/gen-dial-cadence.py src/templates)
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
# a no-show filed on the end of day (Call outcome filed's event): TRC never marks GHL's status (D354)
N(id="t_noshow_eod", type="trigger", event="appointment.outcome", match={"and": [{"eq": ["{{event.outcome}}", "noshow"]}, {"eq": ["{{appointment.term.category}}", "closing"]}]})
N(id="c_once", type="check", title="Not already in a cycle (a repeat purchase never restarts one)", when={"not": {"in": [FV("cycle_status"), ["Active", "Paused"]]}}, else_exit="already in a cycle")
E("t_leap", "c_once"); E("t_enroll", "c_once")
N(id="b_resets", type="branch", title="How many no-show resets already?")
N(id="v_r1", type="set_var", key="resets", value="1"); N(id="v_r2", type="set_var", key="resets", value="2")
N(id="n_cap", type="update_contact", title="Third no-show: long-term nurture, out of the lists", fields=[{"id": F("cycle_status"), "value": "Long-term Nurture"}], clear=[F("next_call_due")])
N(id="g_cap", type="tags", add="long-term-nurture")
N(id="x_cap", type="exit", reason="no-show cap: long-term nurture")
E("t_noshow", "b_resets"); E("t_noshow_eod", "b_resets")
E("b_resets", "n_cap", when={"gt": [FV("no_show_resets"), 1]}, label="2 resets already"); E("n_cap", "g_cap"); E("g_cap", "x_cap")
E("b_resets", "v_r2", when={"gt": [FV("no_show_resets"), 0]}, label="1 reset"); E("b_resets", "v_r1", **{"else": True, "label": "first no-show"})
N(id="n_resets", type="update_contact", title="Count the no-show reset", fields=[{"id": F("no_show_resets"), "value": "{{vars.resets}}"}])
E("v_r1", "n_resets"); E("v_r2", "n_resets")
N(id="c_booked", type="check", title="No upcoming booking (booking always overrides dialing)", when={"eq": ["{{contact.has_upcoming_call}}", False]}, else_exit="booked")
N(id="c_dq", type="check", title="Not marked dq-financial", when={"not": {"has": ["{{contact.tags}}", "dq-financial"]}}, else_exit="dq-financial")
E("c_once", "c_booked"); E("n_resets", "c_booked"); E("c_booked", "c_dq")
N(id="v_start", type="set_var", key="start", when={"exists": "event.cycle_start"}, value="{{event.cycle_start}}", else_value="{{now}}", title="The cycle starts now (or when the operator's backfill says it did)")
N(id="v_last", type="set_var", key="last", value="{{vars.start}}", title="No call made yet in this cycle")
# D355 (Tyler, 2026-11-20: "they're not in the speed to lead so something is broken"): Next Call Due is written the moment they enter,
# so the smart lists show them at once. Calling hours only hold when the call's 4-hour "not dialed" clock starts; a lead in at 9 PM
# held for 8 AM would miss Speed to lead (Created = Today) altogether.
N(id="n_enter", type="update_contact", title="Enter the cycle: status, reason, start, attempts, call due today",
  fields=[{"id": F("cycle_status"), "value": "Active"}, {"id": F("entry_reason"), "value": "{{vars.reason}}"}, {"id": F("cycle_start"), "value": TODAY}, {"id": F("attempt_count"), "value": "{{event.attempts_done | default:0}}"}, {"id": F("next_call_due"), "value": TODAY}],
  clear=[F("last_outcome"), F("paused_at")])
N(id="v_reason", type="set_var", key="reason", value="{{event._type}}", pick={"appointment.status_changed": "No-show", "appointment.outcome": "No-show", "operator.enrolled": "{{event.entry_reason | default:Never booked}}"}, else_value="Never booked", title="Entry reason: no-show, what the operator said, else never booked")
E("c_dq", "v_reason"); E("v_reason", "v_start"); E("v_start", "v_last"); E("v_last", "n_enter")

# ---- the 12 calls as one loop: vars.n is the call due next; only the waits differ by call (D354: one shared body keeps the chart small)
N(id="v_n", type="set_var", key="n", value="{{event.start_at | default:1}}", title="The call they start at (1, or the backfill's)")
E("n_enter", "v_n")
N(id="b_next", type="branch", title="Which call is next?")
E("v_n", "b_next")
def W(wid, anchor, off, rule, title):
  N(id=wid, type="wait", title=title, rule={"anchor": anchor, "offset": off, "tz": "contact", **rule}); return wid
# day 1
W("w1", "now", "+0m", CALLS, "Call #1: at once, in calling hours")
W("w2a", "vars.start", "+30m", CALLS, "Call #2: 30 minutes after entry"); W("w2b", "vars.last", "+25m", CALLS, "and 25 minutes after the last call")
W("w3a", "vars.start", "+2h", CALLS, "Call #3: 2 hours after entry"); W("w3b", "vars.last", "+90m", CALLS, "and 90 minutes after the last call")
E("b_next", "w1", when={"eq": ["{{vars.n}}", "1"]}, label="call #1"); E("b_next", "w2a", when={"eq": ["{{vars.n}}", "2"]}, label="call #2"); E("b_next", "w3a", when={"eq": ["{{vars.n}}", "3"]}, label="call #3")
E("w2a", "w2b"); E("w3a", "w3b")
# days 2-5: one a day, rotating windows, at least 12 hours after the last call
WIN = {"MORN": MORN, "AFT": AFT, "EVE": EVE}
# each call its own waits (a wait two calls shared is lost from a run's path drawing)
HOURS = {"MORN": "8-11am", "AFT": "12-4pm", "EVE": "4-8pm"}
for n, d, w in [(4, 1, "MORN"), (5, 2, "AFT"), (6, 3, "EVE"), (7, 4, "MORN")]:
  W("wd%d" % n, "vars.start", "+%dd" % d, WIN[w], "Call #%d: day %d, %s" % (n, d + 1, HOURS[w]))
  W("wl%d" % n, "vars.last", "+12h", WIN[w], "and 12 hours after the last call")
  E("b_next", "wd%d" % n, when={"eq": ["{{vars.n}}", str(n)]}, label="call #%d" % n); E("wd%d" % n, "wl%d" % n)
# weeks: one a week after the last call, rotating windows
for n, w in [(8, "MORN"), (9, "AFT"), (10, "EVE"), (11, "MORN"), (12, "AFT")]:
  W("ww%d" % n, "vars.last", "+7d", WIN[w], "Call #%d: a week after the last, %s" % (n, HOURS[w])); E("b_next", "ww%d" % n, when={"eq": ["{{vars.n}}", str(n)]}, label="call #%d" % n)
# 12 calls made
N(id="n_done", type="update_contact", title="12 calls made: completed", fields=[{"id": F("cycle_status"), "value": "Completed"}], clear=[F("next_call_due")])
N(id="g_done", type="tags", add="long-term-nurture"); N(id="x_done", type="exit", reason="completed: long-term nurture")
E("b_next", "n_done", **{"else": True, "label": "12 calls made"}); E("n_done", "g_done"); E("g_done", "x_done")
# the call itself, shared
N(id="s_in", type="check", title="Still in the cycle", when={"not": LEFT}, else_exit="left the cycle")
for wid in ["w1", "w2b", "w3b", "wl4", "wl5", "wl6", "wl7", "ww8", "ww9", "ww10", "ww11", "ww12"]: E(wid, "s_in")
N(id="due", type="update_contact", title="The call is due: Next Call Due = today", fields=[{"id": F("next_call_due"), "value": TODAY}])
N(id="dial", type="wait_for_event", title="Wait for Nick's dial (4 hours)", event="call.logged", match={"eq": ["{{data.direction}}", "outbound"]}, until={"anchor": "now", "offset": "+4h", "tz": "contact"}, into="dial", respect_send_window=False)
N(id="cl", type="check", title="Still in the cycle before saying it is late", when={"not": LEFT}, else_exit="left the cycle")
N(id="late", type="slack_post", title="Not dialed 4 hours after it was due: tell the team", channel="{{slack.channel.alerts}}", fallback_channel="{{slack.channel.bookings}}",
  **{"as": {"name": "Dial cadence", "icon": ":telephone_receiver:"}}, template="Call #{{vars.n}} to <https://app.gohighlevel.com/v2/location/{{crm.location_id}}/contacts/detail/{{contact.ghl_contact_id | default:}}|{{contact.name | default:someone}}> has been due 4 hours and not dialed. They stay on the list until it is.")
# Tyler, 2026-11-19: no auto-advance and no attempt that did not happen: not dialed, they stay due until Nick dials
N(id="dial_b", type="wait_for_event", title="Still due: wait for the dial", event="call.logged", match={"eq": ["{{data.direction}}", "outbound"]}, into="dial", respect_send_window=False)
N(id="rec", type="update_contact", title="Dial made: count it, off the lists until the next one is due", fields=[{"id": F("attempt_count"), "value": "{{vars.n}}"}, {"id": F("last_call_at"), "value": TODAY}], clear=[F("next_call_due")])
N(id="v_last2", type="set_var", key="last", value="{{now}}", title="The last call is now")
N(id="v_inc", type="set_var", key="n", value="{{vars.n}}", pick={str(i): str(i + 1) for i in range(1, 13)}, else_value="13", title="Next call")
E("s_in", "due"); E("due", "dial"); E("dial", "rec", label="event"); E("dial", "cl", label="until"); E("cl", "late"); E("late", "dial_b"); E("dial_b", "rec", label="event")
E("rec", "v_last2"); E("v_last2", "v_inc"); E("v_inc", "b_next")

cad = {"slug": "dial-cadence", "name": "Dial cadence", "category": "setter", "stage": "nurture", "sort": 40, "origin": "default", "optional": True,
 "description": "Calls for people who have not booked: Leap buyers who never booked (or anyone the operator enrolls) and closing-call no-shows (GHL's status, or the closer's end of day). Each gets up to 12 calls: one at once, 30 minutes and 2 hours later, one a day for four days in rotating windows, then one a week for five weeks, only 8am to 8pm in their time and never on a Sunday or US federal holiday. The engine sets Next Call Due when a call is due (the smart lists show it) and counts every dial from GHL; a call not dialed 4 hours after it was due is said to the team once and stays due (no attempt is counted that was not made); booking, a purchase or dq-financial takes them out (Dial cadence: exits). A no-show restarts the cycle, at most twice; the third goes to long-term nurture. Nothing is sent to the person.",
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
