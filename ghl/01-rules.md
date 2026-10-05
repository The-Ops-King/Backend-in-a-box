# Standing rules

Binding for every build and every install. Violating any of these creates work that
has to be undone rather than extended.

## Build order

**Fields first. Object after the field list is frozen — which is *before* workflows, not after.**

Custom object schemas cannot be deleted. The instinct is to build the object as late as
possible; that instinct is wrong, because GHL will not offer the "Create an Associated
Record" action until the object and association exist. A workflow that writes to Sales
Call cannot be built before Sales Call exists.

The real constraint was never "after workflows." It is "after the field list stops moving."
Object key `custom_objects.sales_call`, decided once, permanent. It is the join key.

Field *keys* are also permanent, but a badly-keyed field can be deleted and recreated.
Field *labels* rename freely. So the only truly irreversible decision is the object key
and the decision to create the object at all.

## Every workflow is built OFF

A workflow that is ON at the source is ON at the destination. SMS and email triggers
included. Snapshot with everything off; turn on per client only after migration finishes.

The failure this prevents: first import into a client with an existing contact list fires
reminders at every one of them.

## Naming

- `[CORE]` — ships in the snapshot, untouched, holds the logic
- `[STANDARD]` — ships empty, extension point, client-specific additions go here
- `[CUSTOM]` — client-specific, never travels
- Core fields carry a `* ` prefix so they sort to the top and read as off-limits
- Niche fields carry no prefix and live in a separate **Qualification** folder

## Owner fields are stamped, never typed

`closer` comes from Assigned User. `setter` from `setter_owner`, stamped write-once at
booking. Both written by workflow from the user object.

They are Text fields that no human ever types into. A dropdown of names would make hiring
a configuration change. Free typing puts James, james, and JAmes in the dashboard.

## No keyword matching for meaning

Anywhere the system has to decide what something *means* — did this answer satisfy the
gate, does this reply count as a confirmation — that is a semantic call, not a string
comparison. Exact identifier matching only for IDs, slugs, and enum values.

## GHL stores, the dashboard computes

Business-hours math, speed-to-lead averages, open-disposition sweeps: store raw
timestamps in GHL, subtract externally. A metric definition that lives inside a workflow
has to be rebuilt every time a client changes their hours.
