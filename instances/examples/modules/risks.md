---
module: risks
status: agreed
owner: p.natarajan
---
# Risks

## Risks and mitigations

| # | Risk | Owner | Likelihood / impact | Mitigation | Current → projected |
| --- | --- | --- | --- | --- | --- |
| R1 | Mainframe change windows in April and May cannot both be used for the Policy Data Management service exposures (Finance year-end freeze), delaying increment 1 | Derek Fong | Medium / High | Book both windows now; prepare all four exposures for April so May is contingency; stub the services so CRM build proceeds regardless | High → Medium |
| R2 | BIBIT contract variation for real-time claims payment is not agreed in time for increment 3 | Anaru Pihema | Medium / High | Variation drafted in April; fallback is the existing batch payment file to the bank, which meets a two-day rather than one-day target | High → Low |
| R3 | CRM vendor's workflow extension cannot express the complex-claim routing rules | Priya Natarajan | Low / Medium | Rules proven in a spike during increment 1; routing table held outside the CRM in Claims InfoServ so it can move if needed | Medium → Low |
| R4 | Document migration exposes documents belonging to closed claims that should have been disposed of | Karen Doyle | Medium / Medium | Retention rules confirmed before migration design (Q4); disposal pass runs before migration; migration is claim-indexed so gaps are visible | Medium → Low |
| R5 | Daily posting of claims payments breaks Finance's month-end reconciliation | Liam O'Connor | Low / High | Reconciliation redesigned in increment 2 with Finance; parallel run for one month-end before increment 3 | Medium → Low |
| R6 | Handlers bypass the new workflow during the transition, reintroducing re-keying | Hana Te Rangi | Medium / Medium | Change programme with floor-walkers for four weeks; old screens made read-only for Register and Accept at the end of increment 1 | Medium → Low |
| R7 | Weather-event claim surge exceeds capacity in the first season after go-live | Mereana Walker | Low / High | Services sized at five times daily peak; surge runbook adds server instances within a day | Low → Low |

## Open issues

- I1 — Whether the claims data mart feed needs its own privacy impact assessment (open question Q5). Owner: Elena Rossi. Needed before increment 2 design freeze.
- I2 — The senior-handler routing threshold for liability and legal-aid claims is not yet agreed (Q3). Owner: Hana Te Rangi. Needed for increment 2.
- I3 — The bank's real-time payment API sandbox has not yet been provisioned for KCM; testing in increment 3 depends on it. Owner: Anaru Pihema.
- I4 — Whether the CRM vendor's next major release (scheduled mid-year) changes the workflow extension API; vendor to confirm. Owner: Priya Natarajan.
