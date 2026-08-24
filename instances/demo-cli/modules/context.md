---
module: context
status: agreed
owner: c.barlow
---
# Context

## Business driver

Contoso reassesses a client's income and asset position periodically to confirm
ongoing benefit eligibility, but today's reassessment notice is a single
letter sent at the start of the reassessment window with no follow-up.
Clients who miss or misplace that letter often only find out their payment
has been suspended when it stops arriving. This initiative introduces
automated SMS/email reminders in the lead-up to a client's reassessment due
date, reducing avoidable payment suspensions caused by missed paperwork
rather than genuine ineligibility.

## Affected domains

- Case management (CMS)
- Client-facing self-service (ContosoSelfService)
- Notifications and correspondence (WEKA, Correspondence)
- Payments (SWIFTT)

## Explicitly out of scope

Changing the reassessment process itself, its evidentiary requirements, or
the underlying eligibility rules is out of scope — this initiative only adds
reminder notifications ahead of the existing due date. A two-way SMS
reply/upload channel is also out of scope for this first release; reminders
link clients through to the existing ContosoSelfService upload flow.
