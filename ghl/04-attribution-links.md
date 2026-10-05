# Attribution link library

Append to any calendar link or form URL. GHL captures UTMs natively on both.

**If a calendar is embedded in an iframe on the client's own site, the UTMs must go on the
iframe `src`, not the parent page URL.** The parent page URL is not what GHL reads.

## Calendar base URLs

| Calendar | URL |
|---|---|
| Setter Discovery | `https://api.leadconnectorhq.com/widget/booking/kbEwrOhdlzxAHIpNLqF7` |
| Closer Call (Setter Booked) | `https://api.leadconnectorhq.com/widget/booking/GLWzPNAZPoxkROdFJbPH` |
| Closer Call (Self Book) | `https://api.leadconnectorhq.com/widget/booking/RzQgbmwwCIJeHv8YLXO8` |

## Standard combinations

Lowercase, underscores, never spaces. `utm_term` stays empty.

```
?utm_source=instagram&utm_medium=bio
?utm_source=instagram&utm_medium=story
?utm_source=instagram&utm_medium=post
?utm_source=instagram&utm_medium=reel
?utm_source=instagram&utm_medium=dm
?utm_source=youtube&utm_medium=description
?utm_source=youtube&utm_medium=comment
?utm_source=facebook&utm_medium=post
?utm_source=tiktok&utm_medium=bio
?utm_source=email&utm_medium=broadcast
?utm_source=email&utm_medium=newsletter
?utm_source=sms&utm_medium=broadcast
?utm_source=podcast&utm_medium=description
?utm_source=referral&utm_medium=dm&utm_campaign=PARTNER_SLUG
?utm_source=partner&utm_medium=post&utm_campaign=PARTNER_SLUG
```

## Per-rep links

`[CORE] Stamp Attribution` reads `utm_content`. A `closer_` or `setter_` prefix assigns
the contact to that rep, and Always Book With Assigned User does the rest — the booking
lands on them and the reminder comes from them.

```
?utm_source=instagram&utm_medium=dm&utm_content=closer_one
?utm_source=instagram&utm_medium=dm&utm_content=closer_two
?utm_source=instagram&utm_medium=dm&utm_content=setter_one
```

Rename these to real reps at install. Each rep needs an SOP page: which link is yours,
where to use it, what breaks if you use the generic one.

## Meta ads — do not hand-build

Set once per ad account in the ad's URL Parameters field:

```
utm_source=facebook&utm_medium=ad&utm_campaign={{campaign.name}}&utm_content={{ad.name}}
```

## Unrecognized values

A value arriving that is not in the seeded dropdown **still gets stamped** and lands in
the hygiene queue. Never silently discarded. The dropdown prevents most drift; the
hygiene queue catches the rest.