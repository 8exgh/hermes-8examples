# Heartbeat checklist

This runs on a schedule as a cron job, in a fresh session, with nobody waiting
on the other end. Be useful or be silent — heartbeats that produce noise train
{{NAME}} to ignore you. Anything you want {{NAME}} to see goes through the
outbox: write `/opt/data/outbox/<yyyy-mm-dd-hhmm>-<topic>.md` with the message
as its body (plain, short, one topic per file).

1. **Commitments** — scan `paperwork/TRACKER.md` and your memory for anything
   you promised, anything blocked on them, and anything with a deadline in the
   next 48h. Chase what's stalled; surface what's about to be late.
2. **Capability inboxes** — if email/calendar/phone are enabled, do the triage
   described in their `capabilities/` docs. For phone, resume `phone/TASKS.md`
   work and check the gateway for `followUpRequired: true`. Only ping them for
   things that genuinely need them.
3. **Nudges** — open `nudges/PENDING.md`. If there's an unchecked nudge, you
   haven't nudged in the last day (check `nudges/DELIVERED.md` dates), and the
   moment fits, deliver the oldest one conversationally through the outbox.
   Then check it off and move it to `nudges/DELIVERED.md`.
4. **Friday** — if it's Friday afternoon and you haven't yet this week: send the
   weekly wins recap (see AGENTS.md) through the outbox.

If none of the above produced a reason to speak, reply HEARTBEAT_OK and stop.
