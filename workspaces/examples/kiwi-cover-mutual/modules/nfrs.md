---
module: nfrs
status: agreed
owner: p.natarajan
---
# Non-Functional Requirements

## Scalability and capacity

About 38,000 claims a year, peaking at about 600 claims a day after a major weather event (claims volumes report FY2025). The shared services are sized for 3,000 registrations a day, five times that peak (target assumption). Policy Data Management exposures were tested at 20 transactions a second against a design peak of 4 a second (capacity test CT-03). Documents grow by about 90 GB a year (records volumes report FY2025).

## Performance

- Claim registration, including the policy check, completes within 3 seconds at the 95th percentile (target assumption).
- CIS and Claims InfoServ reads return within 500 ms at the 95th percentile (target assumption).
- The BIBIT gateway accepts a payment request within 5 seconds (BIBIT service agreement, schedule 2).
- The nightly data mart extract fits its two-hour window (data platform batch schedule).

## Availability and continuity

- Claim registration and customer information: 99.9 percent during service hours, 07:00–21:00 seven days a week (target assumption).
- Claims payment: 99.5 percent, bounded by the BIBIT gateway (BIBIT service agreement, schedule 2).
- Policy Data Management: the mainframe's existing 99.95 percent (mainframe service catalogue).
- If a shared service is down, the CRM System switches to the manual step, tested quarterly.

## Disaster recovery and backup

- RTO: 4 hours for the shared services and the CRM System workflow (target assumption); the mainframe and the Financial Application keep their 8-hour RTO (service catalogues).
- RPO: 15 minutes for claim and customer data, by log shipping (target assumption); 24 hours for documents, by nightly snapshot (target assumption).
- Nightly backups are retained 35 days (KCM backup standard); claims records are kept 7 years (records retention schedule).
- Loss of a server, the database host or the data-centre hall is each recovered within the RTO.

## Other non-functional requirements

- Accessibility: web claim and intake forms meet WCAG 2.1 AA.
- Data sovereignty: member data stays in New Zealand; the BIBIT gateway processes payment instructions in Sydney and Auckland, accepted by Treasury and the Privacy Office.
- Auditability: every claim state change records actor, time and previous value, immutable and kept 7 years (records retention schedule).
- Compliance: supports the Fair Insurance Code timeframes and Privacy Act access and correction through CIS.

## Requirements traceability

| Agreed requirement (SOAP) | Realised by | Verified by |
| --- | --- | --- |
| Register a claim once | Claim registration service, PDM-01 and PDM-02 | Increment 1 tests; re-key rate |
| Accept without re-keying | CRM System Accept step on CIS | Increment 1 tests |
| Valuation with routing | Claims InfoServ routing rules | Increment 2 tests |
| Pay within one working day | Financial Application and BIBIT gateway | Increment 3 tests; payment-time metric |
| Documents visible from the claim | Document management system integration | Increment 1 tests |
| Policy intake without re-keying | Take out insurance on CIS and PDM-03 | Increment 3 tests |
| Audit of every state change | Claims InfoServ audit table | Internal Audit review |
