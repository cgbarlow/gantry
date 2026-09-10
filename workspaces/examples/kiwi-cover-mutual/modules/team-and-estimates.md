---
module: team-and-estimates
status: agreed
owner: p.natarajan
---
# Teams, contact persons, and high-level estimates

## Teams required

- Claims Platform Team — delivery lead for the shared services and orchestration; contact Priya Natarajan (Solution Architect)
- Claims Operations — process owner, handler workflow and routing rules; contact Hana Te Rangi (Head of Claims)
- Mainframe Integration — CICS service exposures for Policy Data Management; contact Derek Fong (Mainframe Team Lead)
- Finance Systems — Home & Away Financial Application changes and payment reconciliation; contact Liam O'Connor (Finance Systems Manager)
- Treasury — BIBIT and bank contract and settlement rules; contact Anaru Pihema (Treasury Manager)
- Digital Channels — web policy intake and member notifications; contact Sophie Marsh (Digital Product Lead)
- Contact Centre — telephone intake and seller workflow; contact Grace Ioane (Contact Centre Manager)
- Platform Engineering — UNIX server farm, network, deployment pipeline; contact Mereana Walker (Platform Engineering Lead)
- Information Security — threat model, control register, C&A; contact Sam Okafor (Security Architect)
- Privacy Office — privacy impact assessment; contact Elena Rossi (Privacy Officer)
- Data & Analytics — claims data mart feed; contact Jess Lindqvist (Data Engineering Lead)
- Records Management — document migration and retention rules; contact Karen Doyle (Records Manager)
- Internal Audit — audit trail requirements; contact Marcus Bell (Audit Manager)

## Estimates

| Workstream | Size | Basis |
| --- | --- | --- |
| Shared information services (CIS, Claims InfoServ, Policy Data Management exposures) | L | Two new services, four CICS exposures across two mainframe windows, integration testing against three applications |
| Handle Claim orchestration in the CRM | M | Workflow configuration plus routing rules; the vendor's extension framework is already in use |
| Documents (integration and archive migration) | M | Integration is small; migration volume (about 1.1 million pages) drives the size |
| Payments (BIBIT, Financial Application, bank) | M | Gateway integration is well understood; reconciliation and Treasury sign-off add elapsed time |
| Policy intake (web and telephone) | M | Reuses the services; web form and seller workflow are new |
| Data and reporting feed | S | Extends the existing nightly extract |
| Security, privacy and C&A | S | Standard C&A path; no new platform |

Overall: one Large and five Mediums plus two Smalls, planned as three increments over roughly nine months. Sizing follows the KCM Delivery Office T-shirt scale (S up to six weeks for one team, M up to one quarter, L up to two quarters).

## References

- Claims Service Review 2025 — KCM Claims Operations internal report on cycle time and re-key rates
- ArchiSurance Policy Data Management licence and support renewal, Technology Commercial, March 2026
- BIBIT payment gateway contract and integration guide v4.2
- ArchiMate 3.2 Specification, The Open Group — notation used in the viewpoint diagrams
- KCM Delivery Office T-shirt sizing guide v3
