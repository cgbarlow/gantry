---
module: data
status: agreed
owner: p.natarajan
---
# Data

## Logical data model

The following diagram presents the information structure view, the canonical model for the service contracts.

![Information structure view](asset:kcm-information-structure-view)

The diagram shows how a Customer File holds the customer's insurance requests, policies and damage claims, with every policy product realised by the same policy data. Every field in the CIS and Claims InfoServ contracts maps to one of these entities.

Systems of record: Customer and insurance requests in CIS (contact details mastered in the CRM System); Insurance Policy in Policy Data Management; Damage Claim, valuation and audit trail in Claims InfoServ, with the ledger entry mirrored through PDM-04; documents in the document management system; payments in the Financial Application.

## Data classification

Member personal information is **IN-CONFIDENCE**. Health and third-party details in claims are handled as sensitive personal information, restricted to Claims Handler roles with a need to know. Payment instructions are also in PCI DSS scope. The data mart copy is pseudonymised for Actuarial use. All of it is encrypted in transit and at rest, access is logged, and it stays in New Zealand.

## Data replication

- Services database: streaming replication to the Auckland standby for recovery only (RPO in the NFRs).
- Customer contact: CIS's copy is updated in the same transaction as the CRM System, with a nightly reconciliation report.
- Policy lookups are cached in CIS (see Architectural risks); any write invalidates the cache.
- Non-production is refreshed from masked production data.

## Data retention, archiving and records management

Claims records and documents are kept seven years after the claim closes (records schedule RS-11), then disposed of. Documents already past retention are disposed of before migration (Q4). Closed claims move to lower-tier storage after a year but stay retrievable. Audit records are immutable for the same period. Backup retention is in the NFRs.

## Data migration

One migration: the scanning archive into the document management system, indexed by claim. In increment 2, a disposal pass runs first, then documents migrate claim by claim with a reconciliation report per batch. The CRM System's document link falls back to the archive until a claim is confirmed migrated, so handlers see no gap. Customer contact data is seeded into CIS from the CRM System once in increment 1.
