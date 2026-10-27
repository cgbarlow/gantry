---
module: team-and-estimates
status: agreed
owner: p.natarajan
---
# Teams, contact persons, and high-level estimates

## Teams required

- Claims Platform Team — delivery lead; Priya Natarajan (Solution Architect)
- Claims Operations — process owner; Hana Te Rangi (Head of Claims)
- Mainframe Integration — CICS service exposures; Derek Fong
- Finance Systems — Financial Application changes; Liam O'Connor
- Treasury — BIBIT gateway contract; Anaru Pihema
- Digital Channels and Contact Centre — web and telephone intake; Sophie Marsh
- Platform Engineering — UNIX server farm and pipeline; Mereana Walker
- Information Security and Privacy Office — C&A and PIA; Sam Okafor
- Records Management — document migration; Karen Doyle

## Estimates

| Workstream | Size | Basis |
| --- | --- | --- |
| Shared services | L | Two new services, four CICS exposures, three applications to test against |
| Handle Claim in the CRM System | M | Workflow configuration and routing rules |
| Documents | M | Archive migration volume drives the size |
| Payments | M | Reconciliation and Treasury sign-off add elapsed time |
| Policy intake | M | Reuses the services; new web form and seller workflow |
| Reporting, security and C&A | S | Extends existing extracts; standard C&A path |

Three increments over about nine months, sized on the KCM Delivery Office T-shirt scale.

## References

- Claims Service Review 2025, KCM Claims Operations
- BIBIT gateway contract and integration guide v4.2
- ArchiMate 3.2 Specification, The Open Group
- KCM Delivery Office T-shirt sizing guide v3
