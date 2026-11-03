---
module: key-decisions
status: agreed
owner: p.natarajan
---
# Key decisions

## Key decisions

**AD01: Shared services, not point-to-point (ADR031)**

**In the context of:** shared customer and claim data

**Facing:** copies drifting apart

**We decided for:** CIS and Claims InfoServ as shared services

**And neglected:** point-to-point integration

**To achieve:** one reusable source of data

**Accepting that:** every application depends on them

**AD02: Policy Data Management stays the system of record (ADR032)**

**In the context of:** policies and the claims ledger on the mainframe

**Facing:** the risk of moving it

**We decided for:** four CICS transactions (PDM-01 to PDM-04) as services

**And neglected:** replacing it

**To achieve:** policy access without mainframe change

**Accepting that:** delivery follows the mainframe windows

**Relates to:** AD01

**AD03: The CRM System orchestrates; Claims InfoServ owns claim state**

**In the context of:** Handle Claim across systems

**Facing:** no clear owner of claim state

**We decided for:** CRM System orchestration, Claims InfoServ owning state

**And neglected:** claim state in the CRM System

**To achieve:** one authoritative state

**Accepting that:** a nightly check to keep them in step

**Depends on:** AD01

**AD04: Payments go through the Financial Application**

**In the context of:** paying approved claims

**Facing:** payments needing finance control

**We decided for:** the Financial Application instructing the BIBIT gateway

**And neglected:** the CRM System calling the gateway

**To achieve:** a single payment path

**Accepting that:** dependence on the vendor's release cycle (R2)

**AD05: Documents are claim-indexed**

**In the context of:** claim documents in a scanning archive

**Facing:** documents hard to find

**We decided for:** the document management system, indexed by claim

**And neglected:** keeping both

**To achieve:** every document found from its claim

**Accepting that:** migration cannot be switched back

**AD06: Each increment is switchable**

**In the context of:** incremental delivery

**Facing:** a failing increment

**We decided for:** a switch back to the manual step (principle P5)

**And neglected:** a single cut-over

**To achieve:** a safe rollout

**Accepting that:** the manual step is kept

**AD07: No new platform beyond the BIBIT gateway**

**In the context of:** the existing estate

**Facing:** the cost of another platform

**We decided for:** the existing CRM System, servers and mainframe

**And neglected:** a new claims platform

**To achieve:** a supportable design

**Accepting that:** inheriting their limits

**AD08: The policy-lookup cache is 5 minutes (made during the build)**

**In the context of:** CIS caching policy lookups

**Facing:** UAT claims accepted on a just-changed policy

**We decided for:** cutting the cache from 15 minutes to 5

**And neglected:** keeping 15 minutes

**To achieve:** claims decided on current terms

**Accepting that:** more calls reach Policy Data Management

**Relates to:** AD02
