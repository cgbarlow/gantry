---
module: data
status: agreed
owner: c.barlow
---

## Logical data model

Key entities: Submission (reference code, provider id, upload timestamp, status), Certificate (the uploaded document, linked 1:1 to a Submission), Provider (external id from the authentication service, not stored locally beyond a session token).

## Data classification

Certificates contain health information and are classified Restricted (health/personal). Submission metadata is classified Sensitive (personal).

## Data retention, archiving and records management

Certificates are retained in EOS under the same records-management schedule as other application evidence (7 years). The Provider Portal itself retains no certificate data after a successful handoff to EOS — submissions are purged from the portal's own store within 24 hours of confirmed receipt.

## Data migration

No existing data to migrate — this is a new intake channel; historical paper certificates are out of scope.

## Data replication

None — certificates flow through the portal once and are not replicated outside EOS's existing backup regime.
