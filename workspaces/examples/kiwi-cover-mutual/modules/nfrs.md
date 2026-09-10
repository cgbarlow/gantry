---
module: nfrs
status: agreed
owner: p.natarajan
---
# Non-Functional Requirements

## Scalability and capacity

Current volume is about 38,000 claims a year (roughly 150 a working day, peaking at 600 a day after a significant weather event) and 62,000 policy transactions a year. The shared services are sized for five times the daily peak — 3,000 claim registrations a day — with the UNIX server farm's horizontal scaling (two additional application server instances can be added within the fortnightly window, one within a day in an emergency). Policy Data Management exposures are capacity-tested at 20 transactions a second, against a peak design load of 4 a second. Document storage grows at about 90 GB a year plus the 1.1 million-page migration (about 450 GB); the document management system's storage is provisioned for five years.

## Performance

- Claim registration (web or CRM) completes, including the policy validation call to Policy Data Management, within 3 seconds at the 95th percentile and 5 seconds at the 99th.
- Customer Information Service and Claims Information Service reads return within 500 ms at the 95th percentile under peak load.
- A claims payment request is accepted by the BIBIT gateway within 5 seconds; settlement to the member's account within one working day is a business target measured from the Financial Application.
- Document retrieval from the claim in the CRM within 2 seconds for documents under 10 MB.
- The nightly claims data mart extract completes within the two-hour window shared with Finance month-end processing.

## Availability and continuity

- Claim registration and customer information: 99.9 percent availability during service hours (07:00–21:00 NZ time, seven days), measured monthly; unplanned outages outside service hours are not counted against the target but are reported.
- Claims payment: 99.5 percent, constrained by the payment gateway's own commitment.
- Policy Data Management exposures: bound by the mainframe's existing 99.95 percent availability and its monthly change window.
- Continuity: if a shared service is unavailable, the CRM falls back to the previous manual step for that process step (register on paper form, accept by handler override) so a claim is never lost; the fallback is a configuration switch tested each quarter.

## Disaster recovery and backup

- Recovery time objective: 4 hours for the shared services and CRM workflow; 24 hours for the document management system; the mainframe and the Financial Application keep their existing 8-hour RTO.
- Recovery point objective: 15 minutes for claim and customer data (transaction-log shipping); 24 hours for documents (nightly snapshot).
- Backup: database transaction logs shipped every 15 minutes to the secondary site; full backups nightly, retained 35 days; document store snapshots nightly, retained 90 days; monthly backups retained 7 years for claims records.
- Scenarios that satisfy the targets: loss of one application server (no recovery needed, redundant pair), loss of the primary database host (failover to standby within the RTO), loss of the Wellington data-centre hall (restore to the secondary site within 4 hours from shipped logs).
- Archiving policy: closed claims are archived after 12 months to lower-tier storage and retained per the records schedule (see Data).

## Other non-functional requirements

- Accessibility: the web claim and policy intake forms meet WCAG 2.1 AA; the CRM workflow screens are used by staff only and meet the vendor's accessibility baseline.
- Data sovereignty: all member data is stored and processed in New Zealand; the BIBIT gateway processes payment instructions in its Sydney and Auckland regions, which Treasury and the Privacy Office have accepted for payment data only.
- Auditability: every claim state change records the actor, timestamp and previous value; audit records are immutable and retained 7 years.
- Compliance: the solution supports the Fair Insurance Code claims-handling timeframes and the Privacy Act 2020 access and correction obligations through the Customer Information Service.
- Future considerations: the shared services are designed so that a replacement policy platform can be substituted behind the Policy Data Management service interface without changing the CRM or the Financial Application.

## Requirements traceability

| Agreed requirement (SOAP) | Realised by | Verified by |
| --- | --- | --- |
| Register a claim once, web or telephone | CRM Register step on the claim registration service; web form on the same service | Increment 1 acceptance tests, cycle-time metric |
| Validate policy and item at registration | Policy Data Management exposures PDM-01 (policy lookup) and PDM-02 (insured item lookup) | Service contract tests; re-key rate metric |
| Accept or decline without re-keying | CRM Accept step on CIS and PDM-01 | Increment 1 acceptance tests |
| Valuation with routing for complex claims | CRM Valuate step on Claims InfoServ; routing rules table | Increment 2 acceptance tests |
| Pay within one working day | Claims payment service → Financial Application → BIBIT → bank | Increment 3 acceptance tests; payment-time metric |
| Documents visible from the claim | Document management integration, claim-indexed | Increment 1 acceptance tests |
| Single customer information service | CIS | Service contract tests |
| Policy intake without re-keying | Take out insurance flow on CIS and PDM-03 (policy create) | Increment 3 acceptance tests |
| Premium collection through the gateway | Premium payment service → BIBIT | Increment 3 acceptance tests |
| Claim events in the data mart next day | Nightly extract | Increment 2 acceptance tests |
| Audit of every state change | Claims InfoServ audit table | Internal Audit review |
| NFRs | This module | Performance and DR tests before each increment |
