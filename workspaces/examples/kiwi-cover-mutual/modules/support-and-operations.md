---
module: support-and-operations
status: agreed
owner: m.walker
---
# Support and Operations

## Stakeholders and support contacts

- Business owner — Hana Te Rangi, Head of Claims
- Product owner — Tom Whitaker; first escalation for workflow questions
- Tier 1 — KCM Service Desk; all incidents logged here
- Tier 2 — Technology Operations on-call (Mereana Walker); shared services, CRM workflow, monitoring
- Tier 3 — Claims Platform Team (Priya Natarajan); CIS, Claims InfoServ and workflow defects
- Mainframe Integration — Derek Fong; Policy Data Management exposures and MQ bridge
- Finance Systems — Liam O'Connor; Financial Application and reconciliation
- Treasury — Anaru Pihema; BIBIT gateway contract and settlement
- Records Management — Karen Doyle (interim); retention and disposal
- Information Security — Sam Okafor; any suspected data exposure, immediately

## Environments, URLs and domains

- Production — https://www.kiwicover.co.nz/claims; https://crm.kcm.internal; https://cis.svc.kcm.internal:8443; https://claims.svc.kcm.internal:8443
- UAT — https://uat.kiwicover.co.nz/claims; https://crm-uat.kcm.internal; BIBIT gateway sandbox
- SIT — https://crm-sit.kcm.internal; Policy Data Management test LPAR
- Development — https://crm-dev.kcm.internal; Policy Data Management stubbed

## Operational accounts and licenses

- BIBIT gateway (contracted name: BIBIT Merchant Payment Services, verified against the Treasury contract register) — merchant account and API credentials; Treasury
- CRM System vendor support — support portal accounts; Technology Commercial
- Financial Application vendor support, including the gateway adapter; Finance Systems
- Document management system — three service-account API licences; Records Management
- PagerDuty — on-call seats for Technology Operations
- TLS certificates — internal CA for services; public certificate renewed annually by Platform Engineering

## Monitoring and alerting

Grafana dashboards cover each shared service (rate, latency, errors), the MQ bridge, the payment path and the Handle Claim funnel. PagerDuty alerts: a service unavailable (P1), a raised error rate or MQ queue depth (P2), a missing payment callback (P1 in business hours), and a late nightly extract (P3). The Product Owner is alerted when registrations fall well below the same hour last week. Security events go to Information Security.

## Release procedures

CIS, Claims InfoServ and web form changes go through the Jenkins pipeline to development, SIT, UAT and production in the fortnightly change window. Ansible deploys blue/green, rolling back if the health check fails. Vendor changes use the same environments; Policy Data Management exposures use the monthly mainframe window. Routing rules are configuration, changed in UAT first. Emergency fixes use the expedited change process.

## Support handover readiness

Ready means: a walked-through runbook for every alert, a recovery plan tested end to end, on-call cover for the services and payment path, Service Desk knowledge articles, C&A signed off, dashboards live, the as-built current, and a warranty period after increment 3 with no open P1 or P2 defects.

## Decommission

The Head of Claims and Technology Operations approve decommissioning. Consumers switch to the replacement first; claims records and audit trails go to the records archive for the rest of their retention; guests are destroyed and storage wiped; the BIBIT gateway account and licences are cancelled within their notice periods; and DNS, firewall rules and MQ channels are removed. The Policy Data Management exposures stay for any successor.
