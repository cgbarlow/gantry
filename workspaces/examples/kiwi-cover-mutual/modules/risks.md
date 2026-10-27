---
module: risks
status: agreed
owner: p.natarajan
---
# Risks

## Risks and mitigations

| # | Risk | Owner | Likelihood / impact | Mitigation | Current → projected |
| --- | --- | --- | --- | --- | --- |
| R1 | The April and May mainframe windows can't both be used (Finance year-end freeze) | Derek Fong | Medium / High | Book both now; ready all four exposures for April; stub the services | High → Medium |
| R2 | The BIBIT contract variation isn't agreed in time for increment 3 | Anaru Pihema | Medium / High | Variation drafted in April; fall back to the existing batch payment file | High → Low |
| R3 | The CRM System's workflow extension can't express the routing rules | Priya Natarajan | Low / Medium | Spike in increment 1; rules held in Claims InfoServ | Medium → Low |
| R4 | Migration exposes documents that should have been disposed of | Karen Doyle (interim) | Medium / Medium | Retention rules confirmed first (Q4); disposal pass before migration | Medium → Low |
| R5 | Daily payment posting breaks month-end reconciliation | Liam O'Connor | Low / High | Reconciliation redesigned in increment 2; parallel run for one month-end | Medium → Low |
| R6 | Handlers bypass the new workflow, reintroducing re-keying | Hana Te Rangi | Medium / Medium | Floor-walkers; old screens read-only after increment 1 | Medium → Low |

## Open issues

- I1 — Whether the claims data mart feed needs its own PIA (Q5). Owner: Elena Rossi.
- I2 — The senior-handler routing threshold for liability claims (Q3). Owner: Hana Te Rangi.
- I3 — The bank's payment API sandbox isn't yet provisioned. Owner: Anaru Pihema.
