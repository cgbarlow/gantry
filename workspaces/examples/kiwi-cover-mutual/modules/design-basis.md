---
module: design-basis
status: agreed
owner: p.natarajan
---
# Design Basis

## Constraints

- Policy Data Management stays on the mainframe as the policy system of record. All policy reads and writes go through CICS transactions exposed over MQ.
- The CRM System and the Financial Application change only through their published extension points.
- Everything runs in KCM's Wellington data centre; no cloud landing zone is approved for member data yet.
- The BIBIT gateway must go live within the current gateway contract term.
- Claims data stays in New Zealand.

## Assumptions

- Consent captured at policy inception covers sharing data between KCM's own systems (confirmed by the Privacy Officer).
- The mainframe team can expose two CICS services per monthly window.
- Claim volumes stay within 20 percent of today's for the design horizon.
- The BIBIT gateway keeps supporting the bank's real-time payment API (confirmed in writing).

## Caveats

- Valuation stays partly manual for complex claims; the design provides data and workflow, not automation.
- Telephone intake still involves an insurance seller, now working against the shared services.
- The claims data mart feed is daily, which Finance and Actuarial accept.

## Design principles

| Ref | Principle | How it is achieved |
| --- | --- | --- |
| P1 | Capture once | Data is read and written through shared services, not copied. |
| P2 | Process over systems | Handle Claim is defined once and orchestrates the applications. |
| P3 | Systems of record stay authoritative | Services expose Policy Data Management, the Financial Application and the CRM System; they don't duplicate them. |
| P4 | Least privilege | Each account has the narrowest access its step needs. |
| P5 | Reversible steps | Each increment can be switched off by configuration. |
| P6 | Reuse existing platforms | No new platform beyond the BIBIT gateway. |

## Outcomes and deliverables

| Phase | Outcome / deliverable | Owner |
| --- | --- | --- |
| Design | SOAP, HLD, SAD and SSAD approved | Solution Architecture (P. Natarajan) |
| Increment 1 | Register and Accept live | Claims Platform Team |
| Increment 2 | Valuate, data mart feed, Financial Application integration | Claims Platform Team |
| Increment 3 | Pay via the BIBIT gateway; web and telephone intake | Claims Platform Team |
| Handover | As-built, runbooks, recovery test, C&A sign-off | Technology Operations (M. Walker) |
