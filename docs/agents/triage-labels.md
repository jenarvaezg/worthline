# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual GitHub label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role, use the corresponding GitHub label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Priority axis

Orthogonal to the triage roles above. One label; absence means normal priority.

| Label           | Meaning                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `priority-high` | Grab first — jumps the `ready-for-agent` queue. Reserved for real-user-blocking work; if most open issues carry it, it means nothing. |
