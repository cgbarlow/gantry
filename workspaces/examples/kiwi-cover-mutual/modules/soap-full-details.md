---
module: soap-full-details
status: agreed
owner: p.natarajan
---
# Full SOAP Details

## Epic/Project

KCM-2026-014 Claims Handling Modernisation

## Requested/lead by

Hana Te Rangi, Head of Claims (sponsor); Priya Natarajan, Solution Architect (lead)

## Request date

9 February 2026

## Draft agreed date

27 February 2026

## SOAP/estimate delivered date

13 March 2026

## Sequencing

| Requirement | Team | Estimate | Notes |
| --- | --- | --- | --- |
| Shared information services (CIS, Claims InfoServ) | Claims Platform Team, Mainframe Integration | L | Increment 1; first two CICS exposures in the April window, remaining two in May |
| Claims registration and acceptance in the CRM | Claims Platform Team, Claims Operations | M | Increment 1; can start against stubbed services |
| Document management integration and migration | Claims Platform Team, Records Management | M | Increment 1 integration; migration runs in background through increment 2 |
| Claims valuation and routing rules | Claims Platform Team, Claims Operations | M | Increment 2 |
| Claims data mart feed and audit trail | Data & Analytics, Internal Audit | S | Increment 2 |
| Financial Application integration | Finance Systems | M | Increment 2; needs Treasury sign-off on reconciliation |
| Claims payment via BIBIT and bank | Finance Systems, Treasury, Claims Platform Team | M | Increment 3; depends on contract variation |
| Web and telephone policy intake | Digital Channels, Contact Centre | M | Increment 3; reuses increment 1 services |
| Security, privacy and C&A | Information Security, Privacy Office | S | Runs alongside; C&A sign-off before increment 3 go-live |

## Caveats

- This is a high-level estimate based on the information available at the time of shaping.
- The requirements may not have been sufficiently elaborated to reflect the full complexity of the work.
- The actual effort will differ once the IT requirements are elaborated in detail.
- Timeframes are dependent on prioritisation of this work in the delivery portfolio and the availability of the teams named.
- Some of the changes may be able to be delivered incrementally, and the sequencing above assumes they are.
- Architecture governance recommendations may change the shape of the work and therefore the estimate.
- Resource allocation depends on portfolio prioritisation and on the mainframe change windows.
- Cost is based on full allocation of the Claims Platform Team for the duration; part-time allocation extends the elapsed time.
