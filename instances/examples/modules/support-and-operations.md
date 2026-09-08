---
module: support-and-operations
status: agreed
owner: m.walker
---
# Support and Operations

## Stakeholders and support contacts

- Business owner — Hana Te Rangi, Head of Claims; accountable for the Handle Claim process and its service targets
- Product owner — Tom Whitaker, Claims Product Owner; first escalation for process and workflow questions
- Tier 1 — KCM Service Desk (Ravi Chandra, Service Desk Lead); all incidents logged here, 07:00–21:00 seven days
- Tier 2 — Technology Operations on-call (Mereana Walker, Platform Engineering Lead); shared services, CRM workflow, document management, monitoring alerts
- Tier 3 — Claims Platform Team (Priya Natarajan, Solution Architect); defects in CIS, Claims InfoServ and the workflow extension
- Mainframe Integration — Derek Fong; Policy Data Management exposures and MQ bridge, business hours with on-call for P1
- Finance Systems — Liam O'Connor; Financial Application, payment reconciliation
- Treasury — Anaru Pihema; BIBIT gateway contract, bank settlement issues; gateway vendor support via Treasury
- CRM vendor support — via Claims Platform Team under the enterprise support agreement (P1 response one hour)
- Records Management — Karen Doyle; document retention and disposal
- Information Security — Sam Okafor; security incidents (any suspected data exposure is escalated here immediately, in parallel with Tier 2)
- Escalation path: Service Desk → Technology Operations on-call → Claims Platform Team → vendor; business impact escalated to the Product Owner, then the Head of Claims

## Environments, URLs and domains

- Production (Wellington hall B; DR in Auckland) — member web forms at https://www.kiwicover.co.nz/claims and https://www.kiwicover.co.nz/quote; CRM at https://crm.kcm.internal; CIS https://cis.svc.kcm.internal:8443; Claims InfoServ https://claims.svc.kcm.internal:8443; document management API https://docs.kcm.internal:8443
- User acceptance testing (UAT, Wellington hall A) — https://uat.kiwicover.co.nz/claims; https://crm-uat.kcm.internal; https://cis.uat.svc.kcm.internal:8443; https://claims.uat.svc.kcm.internal:8443; BIBIT sandbox
- System integration testing (SIT) — https://crm-sit.kcm.internal; https://cis.sit.svc.kcm.internal:8443; https://claims.sit.svc.kcm.internal:8443; Policy Data Management test LPAR; payment gateway stubbed
- Development — https://crm-dev.kcm.internal; services on developer namespaces at *.dev.svc.kcm.internal; Policy Data Management stubbed
- Redirects: https://kiwicover.co.nz/claim and /claims/new redirect to https://www.kiwicover.co.nz/claims; the legacy https://claims.archisurance.co.nz domain redirects to the same page until its certificate expires in 2027

## Operational accounts and licenses

- BIBIT payment gateway — merchant account and API credentials; contract owned by Treasury; gateway support portal access for Finance Systems and Technology Operations
- Bank real-time payment API — access through the BIBIT gateway under KCM's banking agreement; Treasury
- CRM vendor enterprise support — support portal accounts for the Claims Platform Team; Technology Commercial
- Financial Application vendor support — including the payment gateway adapter; Finance Systems
- Document management system — API licence for three service accounts; Records Management
- PagerDuty — six on-call seats for Technology Operations and the Claims Platform Team
- TLS certificates — internal CA for service certificates; public certificate for www.kiwicover.co.nz renewed annually by Platform Engineering
- Terms and conditions: the BIBIT agreement's service credits and liability caps are recorded in the Treasury contract register; the CRM support agreement's P1 one-hour response applies to the workflow extension

## Monitoring and alerting

Dashboards in Grafana for each shared service (request rate, latency percentiles, error rate, saturation), the MQ bridge (queue depth, round-trip time), the payment path (instructions sent, callbacks received, mismatches) and the Handle Claim funnel (registrations, acceptances, valuations, payments per hour). Alerts to PagerDuty: service error rate above 2 percent for 5 minutes (P2), any service unavailable for 2 minutes (P1), MQ queue depth above 500 or round-trip above 2 seconds for 5 minutes (P2), payment callback missing for more than 30 minutes (P1 during business hours), nightly extract not complete by 05:00 (P3 to Data & Analytics), document migration batch reconciliation mismatch (P3 to Records Management). Business alerts to the Claims Product Owner: registrations per hour below 20 percent of the same hour last week during service hours. Security events (failed service authentication, privilege changes) go to the security monitoring platform and Information Security.

## Release procedures

Changes to CIS, Claims InfoServ and the web forms go through the Jenkins pipeline (build, unit and contract tests, security scan) to development, then SIT, then UAT, then production in the fortnightly change window with a change record approved by the Product Owner and Technology Operations. Deployment is by Ansible playbook with a blue/green swap on the load balancer and automatic rollback if the health check fails. CRM workflow and Financial Application changes follow the vendors' packaging but the same environments and window. Policy Data Management exposures go through the mainframe monthly change window with the Mainframe Integration team's own procedure. Routing rules and reference data are configuration changes made by the Claims Support Administrator in UAT first, promoted by export/import, and logged. Emergency fixes use the expedited change process with retrospective approval within one working day.

## Support handover readiness

Ready to hand over means: the runbooks for each alert above exist and have been walked through by Technology Operations; the recovery plan has been tested at least once end to end (see Recovery Plan); the on-call roster covers the shared services and the payment path; the Service Desk has the triage guide and knowledge articles for the top ten expected member and handler issues; the C&A sign-off is complete; the monitoring dashboards and alerts are live in production; the as-built document is current; and the Claims Platform Team has completed a warranty period of four weeks after increment 3 with no open P1 or P2 defects.

## Decommission

At end of life the Head of Claims and Technology Operations jointly approve decommissioning. The shared services are stopped after their consumers (CRM workflow, web forms, Financial Application adapter) are switched to their replacement; claims records and audit trails are exported to the records archive and retained for the remainder of the seven-year schedule (see Data); the services' database and application guests are destroyed and their storage wiped to the KCM standard; the BIBIT merchant account, the document management API licences and the PagerDuty seats are cancelled with the notice periods in the Treasury and Technology Commercial registers (90 days for the gateway); the internal DNS records, firewall rules and MQ channels are removed; and the Policy Data Management exposures are left in place for any successor unless the mainframe itself is being retired.
