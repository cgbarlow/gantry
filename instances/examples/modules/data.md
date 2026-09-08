---
module: data
status: agreed
owner: p.natarajan
---
# Data

## Logical data model

The solution's data is organised around the customer, their policies and their claims; the shared services expose that model, and Policy Data Management remains the record for the policy part of it.

### Information structure view

![Information structure view](asset:kcm-information-structure-view)

A Customer aggregates a Customer File, which is composed of the customer's Insurance Requests (policy applications), Insurance Policies and Damage Claims. An Insurance Policy is specialised by product — travel, car (motor), home, liability and legal-aid policies — all realised by the same Insurance Policy Data held in Policy Data Management. A Damage Claim is associated with the policy it is made under and is realised by Damage Claim Data (held in Claims InfoServ); a Claim Form (the member's submission and supporting documents, held in the document management system) realises the claim's evidence. Customer File Data and Insurance Request Data are realised in the Customer Information Service. The diagram is the canonical model for the service contracts: every field in the CIS and Claims InfoServ OpenAPI specifications maps to one of these entities.

Key entities and their systems of record: Customer and Customer File — CIS (synchronised from the CRM as the contact master); Insurance Request — CIS until bound, then Policy Data Management; Insurance Policy — Policy Data Management; Damage Claim and its state, valuation and audit trail — Claims InfoServ, with the ledger entry mirrored to Policy Data Management through PDM-04; Claim Form and documents — document management system; Payment — Home & Away Financial Application.

## Data classification

Member personal information (contact details, policy and insured-item details, bank account for payment) is classified **In-Confidence / Personal** under KCM's classification scheme, which follows the Protective Security Requirements. Claim circumstances can include **health information** (injury details on travel and liability claims) and **third-party personal information** (other drivers, tenants), which are handled as Sensitive Personal and restricted to the Claims Handler roles with a need to know. Payment instructions are additionally in PCI DSS scope between the Financial Application and the gateway. Aggregated claims events in the data mart are In-Confidence (they carry member identifiers) and are pseudonymised for Actuarial use. The classification requires encryption in transit and at rest, role-based access with logging, New Zealand data residency (payment instructions excepted, see NFRs), and a seven-year retention for claims records.

## Data replication

- Services database: streaming replication from the Wellington primary to the Auckland standby (asynchronous, 15-minute RPO), used for disaster recovery only — no reads are served from the standby.
- Customer contact data: the CRM remains the contact master; CIS holds a synchronised copy updated through the customer data modification service within the same transaction, so the two never diverge by design; a nightly reconciliation report flags any discrepancy.
- Policy summary cache: CIS caches policy lookups from Policy Data Management for 15 minutes to protect the mainframe path; the mainframe stays authoritative and any write invalidates the cache.
- Claims data mart: nightly extract of claim events, pseudonymised for the Actuarial schema, identified for the Finance schema.
- Non-production environments are refreshed quarterly from masked production data; no live member data leaves production.

## Data retention, archiving and records management

Claims records (the claim, its state history, valuation, payment reference and audit trail) are retained for seven years after the claim is closed, in line with the Insurance (Prudential Supervision) Act record-keeping requirements and KCM's records schedule RS-11, then disposed of by the records process. Claim documents follow the same schedule; documents from the scanning archive whose claims are already past retention are disposed of before migration rather than migrated (open question Q4, owner Records Management). Closed claims are archived after twelve months to lower-tier storage but remain retrievable from the CRM. Customer and policy records follow the existing policy-administration retention rules (life of the policy plus seven years). Audit records are immutable and retained seven years. Backups are retained as set out in the NFRs (35 days daily, 90 days for document snapshots, monthly for seven years for claims records); the monthly backups are the archival copy.

## Data migration

One migration is in scope: the scanning archive (about 1.1 million pages across roughly 260,000 claims) into the document management system, indexed by claim number. The approach is a background migration during increment 2: a disposal pass first removes documents whose claims are past retention; documents are then migrated claim by claim, oldest first, with a reconciliation report per batch comparing page counts and claim keys; the CRM's document link falls back to the archive until a claim's documents are confirmed migrated, so handlers see no gap. The archive is made read-only at the start and decommissioned once the reconciliation is clean. Policy data is not migrated — Policy Data Management remains the record. Customer contact data is seeded into CIS from the CRM in increment 1 by a one-off synchronisation run, then kept in step by the service.
