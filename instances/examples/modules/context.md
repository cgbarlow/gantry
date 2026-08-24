---
module: context
status: agreed
owner: c.barlow
---
# Context

## Business driver

Contoso wants to extend financial hardship assistance to cover mobile phone
devices and ongoing mobile subscription costs, applied for through ContosoSelfService.
Clients currently have no supported pathway to get help with mobile phone
costs even though a phone is often required to access other Contoso services
and job-seeking tools. This initiative introduces a Mobile Phone Assistance
(MPA) benefit, delivered in partnership with an external mobile carrier, so
clients can apply for, receive, and retain a phone and plan through existing
Contoso channels.

## Affected domains

- Client-facing self-service (ContosoSelfService)
- Case management (CMS)
- Application intake and workflow (EOS, S2P, BPM)
- Payments (SWIFTT)
- Reporting and notifications (WEKA, Correspondence)

## Explicitly out of scope

Selecting or negotiating the mobile carrier partnership itself is out of
scope for this initiative — that commercial arrangement is assumed to exist
by the time this solution is built. Support for multiple concurrent carriers
is also out of scope for the first release; the solution is scoped to a
single carrier integration.
