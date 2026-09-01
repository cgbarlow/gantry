---
module: background
status: agreed
owner: c.barlow
---
# Background and context

## Problem statement

Contoso wants to extend financial hardship assistance to cover mobile phone
devices and ongoing mobile subscription costs, applied for through ContosoSelfService.
Clients currently have no supported pathway to get help with mobile phone
costs even though a phone is often required to access other Contoso services
and job-seeking tools. This initiative introduces a Mobile Phone Assistance
(MPA) benefit, delivered in partnership with an external mobile carrier, so
clients can apply for, receive, and retain a phone and plan through existing
Contoso channels.

For the provider-certificate workstream specifically, providers currently
submit Disability Allowance certificates by fax or post to a National Office
processing team, who manually scan and attach each certificate to the client's
EOS application. This creates multi-day processing delays and a manual
data-entry step prone to misattribution when a certificate arrives without a
clear client reference.

## Affected domains

- Client-facing self-service (ContosoSelfService)
- Case management (CMS)
- Application intake and workflow (EOS, S2P, BPM)
- Payments (SWIFTT)
- Reporting and notifications (WEKA, Correspondence)

## Opportunity

Clients can receive a phone and ongoing connectivity through the same trusted
channel they already use for other hardship assistance, reducing barriers to
accessing Contoso services and employment support.

Providers submit a certificate directly through a self-service portal,
referencing the client's application via a one-time reference code; the
certificate attaches to the correct EOS application automatically, with no
manual scanning or attribution step.

## Success criteria

At least 80% of new Disability Allowance certificates arrive via the portal
(not fax/post) within 3 months of launch; median certificate-to-EOS-attachment
time drops from more than 2 days to under 5 minutes.
