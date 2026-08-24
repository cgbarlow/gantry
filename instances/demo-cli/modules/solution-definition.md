---
module: solution-definition
status: agreed
owner: c.barlow
---
# Solution Definition

## Process flow

CMS already holds each client's reassessment due date. A new scheduled job
reads that date daily and, for any client entering their reminder window
(28, 14, and 3 days out), raises a reminder event. The notifications service
picks up that event, checks the client's contact preferences (SMS, email, or
both — set in ContosoSelfService), and sends a reminder pointing them to the ContosoSelfService upload
flow for their reassessment evidence. Each send is logged back against the
client's CMS record so case managers can see reminder history alongside the
reassessment case.

## High-level solution design

Three pieces: (1) a scheduled reminder-window job reading due dates out of
CMS, (2) the existing notifications service, extended with a new reminder
template and triggered off the job's events, and (3) a small case-manager
view added to CMS showing reminder send history per client. No new client-
facing surface is introduced — reminders link back into ContosoSelfService's existing
upload flow rather than a new one.

## Assumptions and considerations

Assumes client contact details in ContosoSelfService are reasonably current — this
initiative doesn't add a data-quality remediation step for stale contact
information, though the reminder itself may surface a wrong-number/bounce
signal case managers can act on.

## Feature breakdown and involved teams

- Reminder-window scheduled job and CMS due-date read — Case Management
  Platform team
- Reminder notification template and send logic — Notifications team
- Case-manager reminder-history view — Case Management Platform team
- ContosoSelfService upload flow linkage (no new build, existing flow) — Digital
  Channels team
