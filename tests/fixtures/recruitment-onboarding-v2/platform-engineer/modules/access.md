---
module: access
status: agreed
owner: m.walker
---
# Access

## Entitlements

- Building access card — Wellington office, standard hours
- Source control — Platform Engineering organisation, write
- Container platform — administrator, non-production; read, production
- Deployment pipeline — approver on the Platform Engineering pipelines
- Observability platform — standard engineer access
- Service management platform — agent, Platform Engineering queue
- Email groups: platform-engineering, technology-all, oncall-platform
- Shared drive — Technology, Platform Engineering folder
- On-call paging tool — added to the platform rotation from 11 May

## Setup

Set up by Mereana Walker on 16 April 2026, in one pass, from the entitlement list agreed with Tomas Berg on 13 April.

Production container platform access was deliberately granted read-only at setup. The team's convention is that production write access follows the first completed on-call shadow, which is also why the paging tool entry carries a later date than the rest.

## Outstanding at start date

One item outstanding on 20 April: the building access card.

The card was requested on 16 April with everything else, but Facilities produce cards in a weekly batch on Tuesdays and the request missed the 14 April run. The card was issued on 21 April, the day after she started. Marama was signed in by a colleague on her first morning.

No harm done on this occasion, but this is not a Technology dependency and nothing in the provisioning sequence knows about the Tuesday batch. A start date on a Monday will hit this every time unless the card is requested before the rest of the provisioning run.
