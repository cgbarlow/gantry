---
module: design-basis
status: agreed
owner: c.barlow
---
# Design Basis

## Constraints

- Must run in the existing Contoso AWS landing zone (`contoso-prod-govt`,
  `ap-southeast-2`) and reuse the existing Contoso API Gateway and `*.contoso.com`
  wildcard certificate — no new public IP or domain.
- Must not hold any client-identifying data at rest beyond what EOS already
  holds; the portal may only ever show a masked name and month/year of birth.
- All infrastructure is defined in Terraform and deploys via pipeline.

## Assumptions

- The external provider-authentication service is available and returns a
  provider registration number in its `id_token`.
- EOS reference codes are created at application time and are available in the
  `reference_codes` table within the `eos-sync` interval (nominally 5 minutes).
- The existing shared Postgres instance has capacity for the additional
  `intake` schema.
- The carrier will provide a portal that can be linked from ContosoSelfService to browse
  available phones and plans, and an API for provisioning and terminating a
  subscription once an application is approved. The carrier handles physical
  delivery of the device through its own existing channels (courier or
  in-branch pickup) — Contoso does not take on any device logistics.

## Caveats

- The Redis session store is single-node; a restart mid-session forces the
  provider to start the submission again. Accepted for launch.
- `eos-sync` can lag up to 10 minutes under EOS's end-of-day batch load, so a
  freshly created reference code may briefly 404.

## Design principles

| Ref | Principle | How it is achieved |
|-----|-----------|--------------------|
| DP1 | Least client data | The portal only ever handles a masked name and month/year of birth; nothing client-identifying is stored or logged. |
| DP2 | Reuse before build | Existing API Gateway, wildcard cert, Postgres instance, KMS key and `eos-sync` job are reused rather than replaced. |
| DP3 | Fail closed | An unrecognised or bad-checksum reference code, or a file that fails magic-byte validation, is rejected before any state is written. |
| DP4 | No ambient authority | The Intake API has no public route; it is reachable only from the portal's security group. |

## Outcomes and deliverables

| Phase | Deliverable | Ownership |
|-------|-------------|-----------|
| Design | Solution architecture (SAD/SSAD), C&A evidence pack | Architecture |
| Build | `provider-portal` and `intake-api` services, `007_reference_codes.sql` migration, `eos-sync` extension, Terraform | Provider Portal delivery team |
| Handover | This as-built document, runbook links, operational handover to Contoso Digital Support | Delivery lead + Architecture |
