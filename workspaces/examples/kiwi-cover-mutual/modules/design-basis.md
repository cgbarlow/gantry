---
module: design-basis
status: agreed
owner: p.natarajan
---
# Design Basis

## Constraints

- Policy Data Management stays on the mainframe as the policy system of record for the life of this initiative. All policy reads and writes go through the mainframe integration layer (CICS transactions exposed over MQ); no direct database access.
- The CRM System and the Home & Away Financial Application are vendor products on fixed upgrade cycles; changes are limited to their published extension points and configuration.
- All workloads run in KCM's existing Wellington data centre on the UNIX server farm and the mainframe; there is no cloud landing zone approved for member data until the Information Security review scheduled for the next financial year.
- Deployment is through the existing release pipeline (Jenkins, Ansible) and the fortnightly change window; the mainframe has a monthly change window.
- The BIBIT payment gateway integration must go live within the current gateway contract term, which ends in fourteen months.
- Claims data must remain in New Zealand.

## Assumptions

- Member consent captured at policy inception covers the sharing of customer and claim data between KCM's own systems; no new consent is needed for the shared services. Confirmed with the Privacy Officer.
- The mainframe integration team has capacity for two CICS service exposures per monthly window, which is enough for the four services this design needs across two windows.
- Claim volumes stay within 20 percent of the current 38,000 claims a year for the design horizon; a step change (for example, a major weather event) is handled by the capacity headroom in the NFRs, not by redesign.
- The BIBIT gateway continues to support the bank's real-time payment API; BIBIT has confirmed this in writing.
- The document management system's API licence covers the additional service accounts.

## Caveats

- The valuation step remains partly manual for complex claims (contents over $25,000, motor total loss, any liability claim). The design provides the data and the workflow; it does not automate valuation.
- Telephone intake still involves an insurance seller; what changes is that the seller works in the CRM against the shared services rather than re-keying into the policy system.
- The claims data mart feed is daily, not real-time. Finance and Actuarial have agreed this is sufficient.

## Design principles

| Ref | Principle | How it is achieved |
| --- | --- | --- |
| P1 | Capture once, use everywhere | Customer, policy and claim data are read and written through shared services (CIS, Claims InfoServ, Policy Data Management services) rather than copied between applications. |
| P2 | Process over systems | The Handle Claim process is defined once and orchestrates the applications; no application owns the process. |
| P3 | Systems of record stay authoritative | Policy Data Management remains the record for policies, the Financial Application for money, the CRM for contact; services expose them, they do not duplicate them. |
| P4 | Least privilege | Every service account and user role has the narrowest access that lets the process step complete; the control register records each. |
| P5 | Reversible steps | Each increment can be switched off by configuration, falling back to the previous manual step, so go-live is not a one-way door. |
| P6 | Reuse existing platforms | No new platform is introduced beyond the payment gateway; new components run in the existing UNIX server farm under existing operations tooling. |

## Outcomes and deliverables

| Phase | Outcome / deliverable | Owner |
| --- | --- | --- |
| Design | Approved SOAP, HLD (TAC) and this SAD; SSAD for the support team | Solution Architecture (P. Natarajan) |
| Triage | Agreed requirement set and traceability matrix; data classification sign-off | Claims Product Owner (T. Whitaker) |
| Build increment 1 | Register and Accept steps live: CIS, Claims InfoServ, CRM and Policy Data Management integration, document management indexing | Claims Platform Team |
| Build increment 2 | Valuate step, claims data mart feed, Home & Away Financial Application integration | Claims Platform Team, Finance Systems |
| Build increment 3 | Pay step via BIBIT and bank; web and telephone policy intake | Claims Platform Team, Digital Channels |
| Handover | As-built document, runbooks, recovery plan tested, C&A sign-off, support handover confirmed | Technology Operations (M. Walker) |
