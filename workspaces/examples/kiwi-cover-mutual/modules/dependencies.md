---
module: dependencies
status: agreed
owner: p.natarajan
---
# Dependencies

## Dependencies

The solution depends on the Mainframe Integration team exposing four Policy Data Management transactions as services across two monthly change windows; nothing in increment 1 can be tested end to end until the first two are available. It depends on Treasury completing the BIBIT contract variation that adds real-time claims payment to the existing premium-collection agreement, and on the bank confirming the payment API sandbox for testing. Records Management must confirm the retention rules for migrated claim documents before the migration is designed in detail. The claims data mart feed depends on the Data & Analytics team's nightly extract window, which is shared with Finance month-end processing.

Downstream, the Contact Centre's seller desktop refresh and the Digital Channels website release both plan to consume the shared customer and policy services once they exist, and Finance's payment reconciliation automation assumes the claims payment records the Financial Application will hold.

## Dependency list

- Policy Data Management (mainframe, inherited ArchiSurance platform) — policy and insured-item lookup, claim ledger update; owned by Mainframe Integration
- CRM System — claim registration, handler workflow, customer contact; owned by Claims Platform Team with the vendor
- Home & Away Financial Application — claims payment and premium receipting records; owned by Finance Systems
- BIBIT payment gateway — real-time claims payment and premium collection to the bank; external vendor, contract owned by Treasury
- Bank payment API (via BIBIT) — settlement to member bank accounts; external, owned by Treasury
- Document management system — claim document storage and retrieval; owned by Records Management
- Enterprise message queue (MQ) on the mainframe — transport for Policy Data Management service calls; owned by Mainframe Integration
- Claims data mart and nightly extract — reporting feed; owned by Data & Analytics
- Enterprise identity provider (Active Directory / SSO) — staff authentication and roles; owned by Information Security
- Member identity service (web login) — member authentication for web claims and policy intake; owned by Digital Channels
- Jenkins and Ansible release pipeline — deployment; owned by Platform Engineering
- Monitoring platform (Prometheus / Grafana / PagerDuty) — alerting; owned by Technology Operations
